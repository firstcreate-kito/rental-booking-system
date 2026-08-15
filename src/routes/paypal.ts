import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { paypalConfigured, capturePaypalOrder, paypalBaseUrl } from '../lib/paypal';
import { getBookingPaymentBySession, markBookingPaymentPaid, getBookingSummaryForGroup } from '../db/repository';
import { nowJST } from '../lib/clock';

const app = new Hono<AppBindings>();

/**
 * GET /api/paypal/debug  PayPal認証の診断（一時・原因特定後に削除）。
 * Secret値は出さず、設定の有無・文字数・接続先モード・PayPalの生レスポンスのみ返す。
 * Basic認証の内側なので外部からは見えない。
 */
app.get('/debug', async (c) => {
  const env = c.env as unknown as { PAYPAL_CLIENT_ID?: string; PAYPAL_CLIENT_SECRET?: string; PAYPAL_MODE?: string };
  const id = env.PAYPAL_CLIENT_ID ?? '';
  const sec = env.PAYPAL_CLIENT_SECRET ?? '';
  const baseUrl = paypalBaseUrl(env);
  const out: Record<string, unknown> = {
    mode: env.PAYPAL_MODE ? env.PAYPAL_MODE : '(未設定→sandbox)',
    baseUrl,
    // Client IDは半公開情報（通常ブラウザにも渡る）なので先頭/末尾のみ表示。Secretは長さのみ。
    clientId: { set: !!id, length: id.length, head: id.slice(0, 8), tail: id.slice(-4), hasSpace: /\s/.test(id) },
    secret: { set: !!sec, length: sec.length, hasSpace: /\s/.test(sec) },
  };
  if (!id || !sec) {
    out.result = 'NOT_CONFIGURED（鍵が未登録。wrangler secret put が反映されていません）';
    return c.json(out);
  }
  try {
    const auth = btoa(`${id}:${sec}`);
    const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const text = await res.text();
    out.authHttpStatus = res.status;
    out.authOk = res.ok;
    // トークン本体は伏せ、エラー説明など短い診断情報のみ抜粋
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      out.authBody = { error: j.error, error_description: j.error_description, has_access_token: !!j.access_token };
    } catch {
      out.authBody = text.slice(0, 200);
    }
  } catch (err) {
    out.fetchError = (err as Error).message;
  }
  return c.json(out);
});

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
