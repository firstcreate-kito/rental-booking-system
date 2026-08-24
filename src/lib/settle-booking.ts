import type { AppBindings } from '../types';
import {
  markBookingPaymentPaid,
  createDocumentForGroup,
  reissueReceiptForGroup,
  recordBookingEvent,
  getBookingSummaryForGroup,
  getBookingGroupById,
  failBookingGroup,
  releaseUnpaidStripeHold,
  getCustomerProfile,
  getBookingCalendarData,
} from '../db/repository';
import { refundPayment } from './stripe';
import { notifyPaymentConfirmed, notifyBookingEstablished, notifyBookingFailed, notifyLatePaymentOnReleased } from './notify';
import { finalizeImmediateBooking } from './finalize';
import { syncBookingCalendarEvents, deleteBookingFromCalendar } from './gcal-sync';
import { sendEmail, paymentPendingBookingEmail } from './email';
import { nowJST, todayJST } from './clock';

type Env = AppBindings['Bindings'];

export interface BookingPaymentRow {
  group_id: string;
  amount: number;
  kind?: string | null;
  status?: string;
}

export type SettleResult =
  | { ok: false }
  | { ok: true; additional: true; groupId: string }
  | { ok: true; established: boolean; refunded?: boolean; groupId: string }
  | { ok: true; alreadyConfirmed: true; groupId: string };

/**
 * Stripe で入金確定したブッキング用セッションを「確定」まで進める共通処理（#68 補強）。
 * Webhook（checkout.session.completed / async_payment_succeeded）と、
 * 決済完了ページのポーリング（/api/bookings/payment-status）の両方から呼ぶ。
 * markBookingPaymentPaid・finalizeImmediateBooking はいずれも冪等なので二重実行は安全。
 */
export async function settlePaidBookingSession(
  env: Env,
  bookingPay: BookingPaymentRow,
  sessionId: string,
  paymentIntent: string | null,
  origin: string,
  ctx?: { waitUntil?: (p: Promise<unknown>) => void },
): Promise<SettleResult> {
  const bg = (p: Promise<unknown>) => (ctx?.waitUntil ? ctx.waitUntil(p.catch(() => {})) : void p.catch(() => {}));

  // 追加請求（差額の後日徴収）：本予約フローとは別扱い。入金記録＋領収書を最終金額で再発行。
  if (bookingPay.kind === 'additional') {
    const ar = await markBookingPaymentPaid(env.DB, sessionId, nowJST(), { paymentIntent });
    if (!ar.ok) return { ok: false };
    try {
      const addYen = '¥' + Number(bookingPay.amount).toLocaleString('ja-JP');
      const remark = `${todayJST()} 予約内容変更に伴う追加分 ${addYen} を反映し、変更後の合計金額で再発行しました。`;
      await reissueReceiptForGroup(env.DB, ar.groupId!, remark);
      await recordBookingEvent(env.DB, { groupId: ar.groupId!, type: 'additional_paid', amount: bookingPay.amount, summary: `追加分 ${addYen} のお支払いを確認`, actor: 'system' }, nowJST());
    } catch {
      /* 領収書再発行・履歴記録の失敗は決済処理に影響させない */
    }
    return { ok: true, additional: true, groupId: ar.groupId! };
  }

  const group = await getBookingGroupById(env.DB, bookingPay.group_id);
  const r = await markBookingPaymentPaid(env.DB, sessionId, nowJST(), { paymentIntent });
  if (!r.ok) return { ok: false };
  const groupId = r.groupId!;

  // 仮押さえを解放（自動キャンセル）した後に着金したレアケース（主に銀行振込）。
  // 枠は既に手放しているため自動確定はせず、入金だけ記録して管理者へ要対応通知する（#39）。
  if (group && (group.status === 'cancelled' || group.status === 'failed')) {
    console.warn('[settle] paid after release (late payment)', { groupId, bookingNumber: group.booking_number, groupStatus: group.status, method: group.payment_method });
    bg(notifyLatePaymentOnReleased(env, groupId));
    return { ok: true, established: false, groupId };
  }

  // 決済先行（#68・カード/PayPal）：pending は入金確定時に空きを再確認して成立 or 不成立＋返金。
  // （コンビニ・銀行振込は confirmed で確保済みのため下の確定済みブロックで処理する）
  if (group && (group.status === 'pending' || group.status === 'tentative')) {
    const outcome = await finalizeImmediateBooking(env, groupId, origin);
    if (outcome === 'confirmed' || outcome === 'already') {
      console.log('[settle] established (payment-first)', { groupId, bookingNumber: group.booking_number, outcome, method: group.payment_method });
      try { await createDocumentForGroup(env.DB, groupId, 'receipt'); } catch { /* 書類発行失敗は決済に影響させない */ }
      bg(notifyBookingEstablished(env, groupId));
      return { ok: true, established: true, groupId };
    }
    // 枠が埋まっていた → 自動返金＋不成立
    console.warn('[settle] slot conflict on finalize → auto-refund + fail', { groupId, bookingNumber: group.booking_number, outcome, method: group.payment_method });
    let refundOk = false;
    if (paymentIntent && env.STRIPE_SECRET_KEY) {
      refundOk = (await refundPayment(env.STRIPE_SECRET_KEY, paymentIntent)).ok;
    }
    console.warn('[settle] auto-refund result', { groupId, bookingNumber: group.booking_number, refundOk });
    await failBookingGroup(env.DB, groupId);
    bg(notifyBookingFailed(env, groupId, refundOk));
    return { ok: true, established: false, refunded: refundOk, groupId };
  }

  // 確定済みの枠（銀行振込・コンビニの入金待ち＝confirmed、または既存の確定予約）への入金確定。
  // 領収書を発行し、入金確認メール（お客様・管理者）を送る。Webhook 再配信（already）時は
  // 二重発行・二重送信しない。
  if (r.already) return { ok: true, alreadyConfirmed: true, groupId };
  console.log('[settle] payment confirmed on confirmed hold', { groupId, bookingNumber: group?.booking_number, method: group?.payment_method });
  let receiptPath: string | null = null;
  try {
    const doc = await createDocumentForGroup(env.DB, groupId, 'receipt');
    if (doc) receiptPath = '/api/documents/' + doc.token;
  } catch {
    /* 書類発行失敗は決済処理に影響させない */
  }
  bg(
    (async () => {
      // 支払いステータス（未入金→入金済み）をGoogleカレンダーの説明欄へ反映
      await syncBookingCalendarEvents(env, groupId, origin);
      await notifyPaymentConfirmed(env, groupId, receiptPath);
    })(),
  );
  return { ok: true, alreadyConfirmed: true, groupId };
}

/**
 * コンビニ払込票の発行時（checkout.session.completed・未入金）に呼ぶ（#39）。
 *  1) 払込票情報を取得（コンビニでなければ何もしない）
 *  2) 枠を confirmed（予約成立・赤枠）にして確保し、Googleカレンダーへ反映（＝枠をブロック）
 *     ※ tentative（商談中）は営業担当の人手用に予約するため、コンビニ入金待ちには使わない。
 *  3) 「コンビニでお支払いください（未入金は自動キャンセル）」メールを送信（払込票URL・期限つき）
 * 枠が既に埋まっていた場合は不成立にして通知（レアケース）。
 * すべて try/catch 済みで、失敗しても Webhook 応答は成功のまま（Stripe 再送の暴発を防ぐ）。
 */
export async function handleKonbiniSlipIssued(
  env: Env,
  bookingPay: BookingPaymentRow,
  _paymentIntentId: string | null,
  origin: string,
  ctx?: { waitUntil?: (p: Promise<unknown>) => void },
): Promise<{ ok: boolean; held?: boolean; reason?: string }> {
  const groupId = bookingPay.group_id;
  const group = await getBookingGroupById(env.DB, groupId);
  // 未入金の completed で payment_method='stripe' かつ pending ＝ コンビニ選択（カードは paid、
  // 銀行振込は payment_method='bank_transfer'）。それ以外はここでは扱わない。
  if (!group || group.status !== 'pending' || group.payment_method !== 'stripe') return { ok: true, reason: 'not-applicable' };

  const bg = (p: Promise<unknown>) => (ctx?.waitUntil ? ctx.waitUntil(p.catch(() => {})) : void p.catch(() => {}));

  // 空きを再確認して「予約成立（confirmed・赤枠）」に昇格＋Googleカレンダーへ反映（finalize が両方実施）。
  const outcome = await finalizeImmediateBooking(env, groupId, origin);
  if (outcome !== 'confirmed' && outcome !== 'already') {
    // 払込票発行時点で他予約に取られていた（レア）→ 不成立にして通知（支払わないよう促す）
    await failBookingGroup(env.DB, groupId);
    bg(notifyBookingFailed(env, groupId, false));
    return { ok: true, held: false, reason: 'conflict' };
  }

  // お支払い待ち予約受付メール（払込番号・支払い方法はStripeのメールを参照。期限内未入金は自動キャンセル）
  bg(
    (async () => {
      if (!group.customer_id) return;
      const prof = (await getCustomerProfile(env.DB, group.customer_id)) as { email?: string; contact_name?: string } | null;
      const to = prof?.email ? String(prof.email) : '';
      if (!to) return;
      const summary = await getBookingSummaryForGroup(env.DB, groupId);
      const mail = paymentPendingBookingEmail({
        customerName: prof?.contact_name ? String(prof.contact_name) : 'お客様',
        bookingNumber: group.booking_number,
        spaceName: summary?.spaceName ?? '',
        eventName: summary?.eventName,
        days: summary?.items ?? [],
        total: group.total_amount,
        paymentMethodLabel: 'コンビニ払い',
        mypageUrl: origin ? `${origin}/mypage.html` : undefined,
      });
      await sendEmail(env, { to, ...mail });
    })(),
  );

  return { ok: true, held: true };
}

/**
 * コンビニ払込票の期限切れ・支払い失敗時（async_payment_failed / checkout.session.expired）に、
 * 未入金の確保枠（confirmed・未入金）を解放して枠を空ける（#39）。カレンダーの予定も削除。
 */
export async function releaseKonbiniHoldForSession(
  env: Env,
  bookingPay: BookingPaymentRow,
  _origin: string,
  ctx?: { waitUntil?: (p: Promise<unknown>) => void },
): Promise<void> {
  // 解放前にカレンダー情報（イベントID）を控える
  const cal = await getBookingCalendarData(env.DB, bookingPay.group_id).catch(() => null);
  const released = await releaseUnpaidStripeHold(env.DB, bookingPay.group_id);
  if (released && cal?.calendarId) {
    const eventIds = (cal.rows ?? []).map((r) => r.google_event_id);
    const bg = (p: Promise<unknown>) => (ctx?.waitUntil ? ctx.waitUntil(p.catch(() => {})) : void p.catch(() => {}));
    bg(deleteBookingFromCalendar(env, cal.calendarId, eventIds));
  }
}
