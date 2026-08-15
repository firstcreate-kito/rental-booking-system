import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { paypalConfigured, capturePaypalOrder } from '../lib/paypal';
import { getBookingPaymentBySession, markBookingPaymentPaid, getBookingSummaryForGroup } from '../db/repository';
import { nowJST } from '../lib/clock';

const app = new Hono<AppBindings>();

/**
 * POST /api/paypal/capture  body:{orderId}
 * PayPal承認後の戻りページから呼ばれ、注文をキャプチャ（代金確定）して予約を入金済みにする（#35）。
 * orderId は booking_payments.stripe_session_id に保存済み（PayPalの注文ID）。
 */
app.post('/capture', async (c) => {
  if (!paypalConfigured(c.env)) return c.json({ error: 'paypal not configured' }, 503);
  const body = await c.req.json().catch(() => ({}));
  const orderId = String((body as Record<string, unknown>).orderId ?? '').trim();
  if (!orderId) return c.json({ error: 'orderId は必須です' }, 400);

  const pay = await getBookingPaymentBySession(c.env.DB, orderId);
  if (!pay) return c.json({ error: '該当する決済が見つかりません' }, 404);

  // 冪等：既にキャプチャ済みならそのまま完了を返す
  if (pay.status === 'paid') {
    const booking = await getBookingSummaryForGroup(c.env.DB, pay.group_id);
    return c.json({ status: 'paid', booking });
  }

  try {
    const cap = await capturePaypalOrder(c.env, orderId);
    if (cap.completed) {
      await markBookingPaymentPaid(c.env.DB, orderId, nowJST());
      const booking = await getBookingSummaryForGroup(c.env.DB, pay.group_id);
      return c.json({ status: 'paid', booking });
    }
    return c.json({ status: cap.status.toLowerCase() });
  } catch (err) {
    return c.json({ error: '決済の確定に失敗しました：' + (err as Error).message }, 502);
  }
});

export default app;
