import type { AppBindings } from '../types';
import {
  markBookingPaymentPaid,
  createDocumentForGroup,
  reissueReceiptForGroup,
  recordBookingEvent,
  getBookingSummaryForGroup,
  getBookingGroupById,
  failBookingGroup,
} from '../db/repository';
import { refundPayment } from './stripe';
import { notifyPaymentConfirmed, notifyBookingEstablished, notifyBookingFailed } from './notify';
import { finalizeImmediateBooking } from './finalize';
import { syncBookingCalendarEvents } from './gcal-sync';
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

  // 決済先行（#68）：pending は入金時に空きを再確認して成立 or 不成立＋返金
  if (group && group.status === 'pending') {
    const outcome = await finalizeImmediateBooking(env, groupId, origin);
    if (outcome === 'confirmed' || outcome === 'already') {
      try { await createDocumentForGroup(env.DB, groupId, 'receipt'); } catch { /* 書類発行失敗は決済に影響させない */ }
      bg(notifyBookingEstablished(env, groupId));
      return { ok: true, established: true, groupId };
    }
    // 枠が埋まっていた → 自動返金＋不成立
    let refundOk = false;
    if (paymentIntent && env.STRIPE_SECRET_KEY) {
      refundOk = (await refundPayment(env.STRIPE_SECRET_KEY, paymentIntent)).ok;
    }
    await failBookingGroup(env.DB, groupId);
    bg(notifyBookingFailed(env, groupId, refundOk));
    return { ok: true, established: false, refunded: refundOk, groupId };
  }

  // 従来フロー（銀行振込の後払い確定など：既に confirmed）
  let receiptPath: string | null = null;
  try {
    const doc = await createDocumentForGroup(env.DB, groupId, 'receipt');
    if (doc) receiptPath = '/api/documents/' + doc.token;
  } catch {
    /* 書類発行失敗は決済処理に影響させない */
  }
  bg(
    (async () => {
      await syncBookingCalendarEvents(env, groupId, origin);
      const summary = await getBookingSummaryForGroup(env.DB, groupId);
      if (summary?.paymentMethod === 'bank_transfer') {
        await notifyPaymentConfirmed(env, groupId, receiptPath);
      }
    })(),
  );
  return { ok: true, alreadyConfirmed: true, groupId };
}
