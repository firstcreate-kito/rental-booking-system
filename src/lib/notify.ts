/**
 * 決済確定など、複数箇所から呼ぶ通知の共通ヘルパー（#49）。
 * リポジトリ照会＋メール送信をまとめる（webhooks / paypal / admin から利用）。
 */
import type { Env } from '../types';
import { getBookingSummaryForGroup, getCustomerProfile } from '../db/repository';
import { sendEmail, paymentConfirmedEmail, adminPaymentConfirmedEmail } from './email';

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
      }),
    });
  }
  if (env.MAIL_ADMIN) {
    await sendEmail(env, {
      to: env.MAIL_ADMIN,
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
