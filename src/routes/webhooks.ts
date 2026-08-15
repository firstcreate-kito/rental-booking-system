import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { verifyStripeWebhook, stripeConfigured } from '../lib/stripe';
import { fulfillTicketPurchase, getBookingPaymentBySession, markBookingPaymentPaid, createDocumentForGroup, getBookingSummaryForGroup, getCustomerProfile } from '../db/repository';
import { sendEmail, ticketPurchaseEmail } from '../lib/email';
import { notifyPaymentConfirmed } from '../lib/notify';
import { nowJST, todayJST, addDaysJST } from '../lib/clock';

const app = new Hono<AppBindings>();

/**
 * POST /api/webhooks/stripe
 * Stripe からの決済完了通知。署名検証に成功し、checkout.session.completed のとき
 * 対象商品のチケットを顧客へ発行する（冪等）。
 * ※ Basic 認証ゲートは index.ts で /api/webhooks/* を除外している。
 */
app.post('/stripe', async (c) => {
  if (!stripeConfigured(c.env)) return c.json({ error: 'stripe not configured' }, 503);
  const payload = await c.req.text();
  const sig = c.req.header('Stripe-Signature');

  let event;
  try {
    event = await verifyStripeWebhook(payload, sig, c.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    // 署名不正は 400（Stripe は再送しない）
    return c.json({ error: 'signature verification failed: ' + (err as Error).message }, 400);
  }

  // 即時決済（カード/Apple Pay）は completed、コンビニ払い等の後払いは
  // 実際の入金時に async_payment_succeeded が届く。両方で「入金確定」を処理する。
  const PAID_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (PAID_EVENTS.includes(event.type)) {
    const session = event.data.object as { id?: string; payment_status?: string };
    // payment_status が paid のときのみ処理（コンビニ受付直後(unpaid)は入金待ちのため対象外）
    if (session.id && session.payment_status === 'paid') {
      // 予約のカード決済か、チケット購入かをセッションIDで判別（#35）
      const bookingPay = await getBookingPaymentBySession(c.env.DB, session.id);
      if (bookingPay) {
        const r = await markBookingPaymentPaid(c.env.DB, session.id, nowJST());
        if (!r.ok) return c.json({ received: true, paid: false }, 500);
        // 入金確定で領収書を自動発行（#41・冪等）
        let receiptPath: string | null = null;
        if (r.groupId) {
          try {
            const doc = await createDocumentForGroup(c.env.DB, r.groupId, 'receipt');
            if (doc) receiptPath = '/api/documents/' + doc.token;
          } catch {
            /* 書類発行失敗は決済処理に影響させない */
          }
          // 銀行振込の入金確認＝予約確定メール（#49）。カード即時決済は予約確認済みのため対象外。
          const groupId = r.groupId;
          c.executionCtx.waitUntil(
            (async () => {
              const summary = await getBookingSummaryForGroup(c.env.DB, groupId);
              if (summary?.paymentMethod === 'bank_transfer') {
                await notifyPaymentConfirmed(c.env, groupId, receiptPath);
              }
            })().catch(() => {}),
          );
        }
        return c.json({ received: true, paid: true, groupId: r.groupId });
      }
      const result = await fulfillTicketPurchase(c.env.DB, session.id, nowJST(), todayJST(), addDaysJST);
      if (!result.ok) {
        // 発行失敗（商品欠落など）は 500 を返して Stripe に再送させる
        return c.json({ received: true, fulfilled: false, reason: result.reason }, 500);
      }
      // チケット購入完了メール（#52）。再配信（already）や情報欠落時は送らない。
      if (!result.already && result.customerId && result.productName) {
        const info = result;
        c.executionCtx.waitUntil(
          (async () => {
            const prof = (await getCustomerProfile(c.env.DB, info.customerId!)) as { email?: string; contact_name?: string } | null;
            const to = prof?.email ? String(prof.email) : '';
            if (!to) return;
            const origin = c.env.PUBLIC_BASE_URL || '';
            await sendEmail(c.env, {
              to,
              ...ticketPurchaseEmail({
                customerName: prof?.contact_name ? String(prof.contact_name) : 'お客様',
                productName: info.productName!,
                totalHours: info.totalHours ?? 0,
                validUntil: info.validUntil ?? '',
                amount: info.amount ?? 0,
                mypageUrl: origin ? `${origin}/mypage.html` : undefined,
              }),
            });
          })().catch(() => {}),
        );
      }
      return c.json({ received: true, fulfilled: true, ticketId: result.ticketId });
    }
  }
  // それ以外のイベントは受領のみ
  return c.json({ received: true });
});

export default app;
