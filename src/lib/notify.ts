/**
 * 決済確定など、複数箇所から呼ぶ通知の共通ヘルパー（#49）。
 * リポジトリ照会＋メール送信をまとめる（webhooks / paypal / admin から利用）。
 */
import type { Env } from '../types';
import { getBookingSummaryForGroup, getCustomerProfile } from '../db/repository';
import {
  sendEmail,
  paymentConfirmedEmail,
  adminPaymentConfirmedEmail,
  bookingConfirmationEmail,
  adminNewBookingEmail,
  bookingFailedEmail,
  adminBookingFailedEmail,
  adminLatePaymentOnReleasedEmail,
  ticketPurchaseEmail,
  adminTicketPurchaseEmail,
} from './email';

/** 管理者通知の既定宛先（MAIL_ADMIN 未設定時のフォールバック・本部）。未入金アラートCronと統一。 */
const DEFAULT_ADMIN_EMAIL = 'rental@space-albe.com';

/**
 * 管理者通知の宛先一覧（#72）。本部（MAIL_ADMIN）＋スペース別の通知先メールを重複なく返す。
 * spaceId 未指定/該当なしなら本部のみ。複数人への配信はメールサーバーの転送で行う想定。
 */
export async function adminRecipients(env: Env, spaceId?: string | null): Promise<string[]> {
  const set = new Set<string>();
  // 本部（rental@space-albe.com）は常に宛先に含める。MAIL_ADMIN 未設定でも管理者メールが
  // 宛先ゼロで無送信になるのを防ぐ（未入金アラートCronと同じ既定）。MAIL_ADMIN が本部と
  // 同一なら Set で重複排除される。
  set.add(DEFAULT_ADMIN_EMAIL);
  if (env.MAIL_ADMIN) set.add(env.MAIL_ADMIN.trim());
  if (spaceId) {
    const row = await env.DB.prepare('SELECT notify_email FROM spaces WHERE id = ?')
      .bind(spaceId)
      .first<{ notify_email: string | null }>();
    if (row?.notify_email) set.add(String(row.notify_email).trim());
  }
  return [...set].filter(Boolean);
}

/**
 * チケット（回数券）購入完了の通知（お客様＋管理者）#52。
 * Webhook（確実）とポーリング確定（Webhook不達時のフォールバック）の両方から呼ぶ。
 * fulfillTicketPurchase は冪等で、新規発行時のみ already=false を返すため、
 * 呼び出し側で「新規発行時だけ」本関数を呼べば二重送信しない。
 */
export async function notifyTicketPurchased(
  env: Env,
  info: { customerId: string; productName: string; totalHours?: number; validUntil?: string; amount?: number },
  origin?: string,
): Promise<void> {
  const prof = (await getCustomerProfile(env.DB, info.customerId)) as { email?: string; contact_name?: string } | null;
  const customerName = prof?.contact_name ? String(prof.contact_name) : 'お客様';
  const customerEmail = prof?.email ? String(prof.email) : '';
  const base = {
    productName: info.productName,
    totalHours: info.totalHours ?? 0,
    validUntil: info.validUntil ?? '',
    amount: info.amount ?? 0,
  };
  // お客様宛（メール登録がある場合のみ）
  if (customerEmail) {
    await sendEmail(env, {
      to: customerEmail,
      ...ticketPurchaseEmail({ customerName, ...base, mypageUrl: origin ? `${origin}/mypage.html` : undefined }),
    });
  }
  // 管理者宛（本部＝MAIL_ADMIN。チケットは複数スペース対象のため本部のみに送る）
  const admins = await adminRecipients(env);
  if (admins.length) {
    await sendEmail(env, { to: admins, ...adminTicketPurchaseEmail({ customerName, customerEmail, ...base }) });
  }
}

/** グループのスペースIDを取得（通知先の解決用）#72 */
async function groupSpaceId(env: Env, groupId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT space_id FROM booking_groups WHERE id = ?')
    .bind(groupId)
    .first<{ space_id: string | null }>();
  return row?.space_id ?? null;
}

/** グループの顧客連絡先（メール・氏名・電話）を取得 */
async function customerContact(env: Env, groupId: string): Promise<{ email: string; name: string; phone?: string }> {
  const row = await env.DB.prepare('SELECT customer_id FROM booking_groups WHERE id = ?')
    .bind(groupId)
    .first<{ customer_id: string | null }>();
  if (!row?.customer_id) return { email: '', name: 'お客様' };
  const prof = (await getCustomerProfile(env.DB, row.customer_id)) as { email?: string; contact_name?: string; phone?: string } | null;
  return {
    email: prof?.email ? String(prof.email) : '',
    name: prof?.contact_name ? String(prof.contact_name) : 'お客様',
    phone: prof?.phone ? String(prof.phone) : undefined,
  };
}

const PAY_LABEL: Record<string, string> = {
  stripe: 'クレジットカード等（Stripe）',
  paypal: 'PayPal',
  bank_transfer: '銀行振込（Stripe収納代行）',
  invoice: '銀行振込（請求書払い）',
};

/**
 * 入金確認・予約確定メール（お客様＋管理者）を送信する（#49）。
 * receiptUrl は相対パス（/api/documents/...）を渡すと絶対URLに補完する。
 */
export async function notifyPaymentConfirmed(
  env: Env,
  groupId: string,
  receiptPath: string | null,
): Promise<void> {
  const summary = await getBookingSummaryForGroup(env.DB, groupId);
  if (!summary) return;
  const row = await env.DB.prepare('SELECT customer_id FROM booking_groups WHERE id = ?')
    .bind(groupId)
    .first<{ customer_id: string | null }>();

  let email = '';
  let name = 'お客様';
  if (row?.customer_id) {
    const prof = (await getCustomerProfile(env.DB, row.customer_id)) as { email?: string; contact_name?: string } | null;
    email = prof?.email ? String(prof.email) : '';
    name = prof?.contact_name ? String(prof.contact_name) : 'お客様';
  }
  const origin = env.PUBLIC_BASE_URL || '';
  const receiptUrl = receiptPath ? (origin ? origin + receiptPath : receiptPath) : undefined;

  if (email) {
    await sendEmail(env, {
      to: email,
      ...paymentConfirmedEmail({
        customerName: name,
        bookingNumber: summary.bookingNumber,
        spaceName: summary.spaceName,
        eventName: summary.eventName,
        days: summary.items,
        total: summary.total,
        receiptUrl,
        spaceNote: summary.spaceEmailNote,
      }),
    });
  }
  const admins = await adminRecipients(env, await groupSpaceId(env, groupId));
  if (admins.length) {
    await sendEmail(env, {
      to: admins,
      ...adminPaymentConfirmedEmail({
        bookingNumber: summary.bookingNumber,
        spaceName: summary.spaceName,
        total: summary.total,
        paymentMethodLabel: PAY_LABEL[summary.paymentMethod || ''] || summary.paymentMethod || '—',
        customerName: name,
        customerEmail: email || undefined,
      }),
    });
  }
}

/**
 * 決済先行フローで予約が「成立」したときの確認メール（お客様＋管理者）#68。
 * 通常の新規予約確認メールと同じ内容を、入金確定のタイミングで送る。
 */
export async function notifyBookingEstablished(env: Env, groupId: string): Promise<void> {
  const summary = await getBookingSummaryForGroup(env.DB, groupId);
  if (!summary) return;
  const { email, name, phone } = await customerContact(env, groupId);
  const origin = env.PUBLIC_BASE_URL || '';
  // 予約フォームの追加項目をメールにも記載（新規予約時の即時確認メールと揃える）
  const extras = [
    { label: '利用目的', value: summary.purpose ?? '' },
    { label: '利用人数', value: summary.headcount ? `${summary.headcount}名` : '' },
    { label: '過去のご利用実績', value: summary.pastUse ?? '' },
    { label: 'ALBEを知ったきっかけ', value: summary.referralSource ?? '' },
    { label: 'ご要望・メッセージ', value: summary.customerMessage ?? '' },
  ].filter((e) => e.value);
  const data = {
    bookingNumber: summary.bookingNumber,
    spaceName: summary.spaceName,
    eventName: summary.eventName,
    customerName: name,
    days: summary.items,
    total: summary.total,
    status: 'confirmed' as const,
    extras,
    mypageUrl: origin ? `${origin}/mypage.html` : undefined,
    changeUrl: origin ? `${origin}/booking-change/?num=${encodeURIComponent(summary.bookingNumber)}` : undefined,
    isInvoice: false,
    spaceNote: summary.spaceEmailNote,
  };
  if (email) await sendEmail(env, { to: email, ...bookingConfirmationEmail(data) });
  const admins = await adminRecipients(env, await groupSpaceId(env, groupId));
  if (admins.length) {
    await sendEmail(env, { to: admins, ...adminNewBookingEmail({ ...data, customerEmail: email || '', customerPhone: phone }) });
  }
}

/**
 * 決済先行フローで枠が埋まっていて「不成立・返金」になったときの通知（お客様＋管理者）#68。
 */
export async function notifyBookingFailed(env: Env, groupId: string, refundOk: boolean): Promise<void> {
  const summary = await getBookingSummaryForGroup(env.DB, groupId);
  if (!summary) return;
  const { email, name } = await customerContact(env, groupId);
  const method = summary.paymentMethod || 'stripe';
  if (email) {
    await sendEmail(env, {
      to: email,
      ...bookingFailedEmail({
        customerName: name,
        bookingNumber: summary.bookingNumber,
        spaceName: summary.spaceName,
        days: summary.items,
        total: summary.total,
        paymentMethod: method,
      }),
    });
  }
  const admins = await adminRecipients(env, await groupSpaceId(env, groupId));
  if (admins.length) {
    await sendEmail(env, {
      to: admins,
      ...adminBookingFailedEmail({
        bookingNumber: summary.bookingNumber,
        spaceName: summary.spaceName,
        days: summary.items,
        total: summary.total,
        paymentMethod: method,
        customerName: name,
        customerEmail: email || undefined,
        refundOk,
      }),
    });
  }
}

/**
 * 解放（自動キャンセル）済みの予約に着金があったときの管理者アラート（#39）。
 * 主に銀行振込で、仮押さえの期限切れ後に振込が届いたレアケース。管理者のみへ通知する。
 */
export async function notifyLatePaymentOnReleased(env: Env, groupId: string): Promise<void> {
  const summary = await getBookingSummaryForGroup(env.DB, groupId);
  if (!summary) return;
  const { email, name } = await customerContact(env, groupId);
  const admins = await adminRecipients(env, await groupSpaceId(env, groupId));
  if (!admins.length) return;
  await sendEmail(env, {
    to: admins,
    ...adminLatePaymentOnReleasedEmail({
      bookingNumber: summary.bookingNumber,
      spaceName: summary.spaceName,
      customerName: name,
      customerEmail: email || undefined,
    }),
  });
}
