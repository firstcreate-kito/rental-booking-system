import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { verifyStripeWebhook, stripeConfigured } from '../lib/stripe';
import { fulfillTicketPurchase, getBookingPaymentBySession, markBookingPaymentPaid, createDocumentForGroup } from '../db/repository';
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
        if (r.groupId) {
          try {
            await createDocumentForGroup(c.env.DB, r.groupId, 'receipt');
          } catch {
            /* 書類発行失敗は決済処理に影響させない */
          }
        }
        return c.json({ received: true, paid: true, groupId: r.groupId });
      }
      const result = await fulfillTicketPurchase(c.env.DB, session.id, nowJST(), todayJST(), addDaysJST);
      if (!result.ok) {
        // 発行失敗（商品欠落など）は 500 を返して Stripe に再送させる
        return c.json({ received: true, fulfilled: false, reason: result.reason }, 500);
      }
      return c.json({ received: true, fulfilled: true, ticketId: result.ticketId });
    }
  }
  // それ以外のイベントは受領のみ
  return c.json({ received: true });
});

export default app;
