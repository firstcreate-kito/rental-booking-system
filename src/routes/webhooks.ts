import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { verifyStripeWebhook, stripeConfigured } from '../lib/stripe';
import { fulfillTicketPurchase } from '../db/repository';
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

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as { id?: string; payment_status?: string };
    // payment_status が paid のときのみ発行（後払い等は対象外）
    if (session.id && session.payment_status === 'paid') {
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
