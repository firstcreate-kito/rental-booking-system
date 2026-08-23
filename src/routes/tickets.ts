import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { requireAuth } from '../middleware/auth';
import {
  getTicketProducts,
  getTicketProduct,
  createPendingPurchase,
  getPurchaseBySession,
  fulfillTicketPurchase,
} from '../db/repository';
import { stripeConfigured, createCheckoutSession } from '../lib/stripe';
import { nowJST, todayJST, addDaysJST } from '../lib/clock';

const app = new Hono<AppBindings>();

/** GET /api/tickets/products 販売中のチケット商品一覧（公開） */
app.get('/products', async (c) => {
  const products = await getTicketProducts(c.env.DB, true);
  return c.json({ products, paymentEnabled: stripeConfigured(c.env) });
});

/** POST /api/tickets/checkout Stripe Checkout セッションを作成（会員のみ） body:{productId} */
app.post('/checkout', requireAuth, async (c) => {
  if (!stripeConfigured(c.env)) {
    return c.json({ error: 'オンライン決済は現在ご利用いただけません。お問い合わせください。' }, 503);
  }
  const body = await c.req.json().catch(() => ({}));
  const productId = String((body as Record<string, unknown>).productId ?? '').trim();
  if (!productId) return c.json({ error: 'productId は必須です' }, 400);
  const product = (await getTicketProduct(c.env.DB, productId)) as
    | { id: string; name: string; price: number; is_active: number }
    | null;
  if (!product || !product.is_active) return c.json({ error: '販売中のチケットが見つかりません' }, 404);

  const customer = c.get('customer');
  const purchaseId = crypto.randomUUID();

  // 戻り先URL（PUBLIC_BASE_URL 未設定ならリクエスト元 origin を使用）
  const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  const successUrl = `${origin}/tickets.html?status=success&session={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/tickets.html?status=cancel`;

  let session;
  try {
    session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY!, {
      productName: product.name,
      amountJpy: product.price,
      successUrl,
      cancelUrl,
      customerEmail: customer.email || undefined,
      clientReferenceId: purchaseId,
      metadata: { purchaseId, customerId: customer.id, productId: product.id },
      // チケットは即時発行のためクレジットカードのみに固定（コンビニ等が自動表示されないよう明示）
      paymentMethodTypes: ['card'],
    });
  } catch (err) {
    return c.json({ error: '決済ページの作成に失敗しました：' + (err as Error).message }, 502);
  }

  await createPendingPurchase(
    c.env.DB,
    { id: purchaseId, customerId: customer.id, productId: product.id, amount: product.price, sessionId: session.id },
    nowJST(),
  );

  return c.json({ url: session.url });
});

/**
 * POST /api/tickets/demo-purchase 動作確認用のテスト購入（決済なしで即発行）body:{productId}
 * ※本番決済（Stripe）が未設定のあいだだけ利用可能。設定後は自動的に無効化される。
 */
app.post('/demo-purchase', requireAuth, async (c) => {
  if (stripeConfigured(c.env)) {
    return c.json({ error: '本番決済が有効なため、テスト購入は利用できません。' }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const productId = String((body as Record<string, unknown>).productId ?? '').trim();
  if (!productId) return c.json({ error: 'productId は必須です' }, 400);
  const product = (await getTicketProduct(c.env.DB, productId)) as { id: string; price: number; is_active: number } | null;
  if (!product || !product.is_active) return c.json({ error: '販売中のチケットが見つかりません' }, 404);

  const customer = c.get('customer');
  const purchaseId = crypto.randomUUID();
  const sessionId = 'demo_' + purchaseId;
  await createPendingPurchase(
    c.env.DB,
    { id: purchaseId, customerId: customer.id, productId: product.id, amount: product.price, sessionId },
    nowJST(),
  );
  // Stripe の決済完了 Webhook と同じ発行処理を直接呼ぶ（テスト用）
  const result = await fulfillTicketPurchase(c.env.DB, sessionId, nowJST(), todayJST(), addDaysJST);
  if (!result.ok) return c.json({ error: 'テスト発行に失敗しました：' + (result.reason ?? '') }, 500);
  return c.json({ ok: true, ticketId: result.ticketId });
});

/** GET /api/tickets/purchase-status?session=... 決済後の反映状況を確認（会員のみ） */
app.get('/purchase-status', requireAuth, async (c) => {
  const sessionId = c.req.query('session');
  if (!sessionId) return c.json({ status: 'unknown' });
  const p = await getPurchaseBySession(c.env.DB, sessionId);
  if (!p || p.customer_id !== c.get('customer').id) return c.json({ status: 'unknown' });
  return c.json({ status: p.status, ticketId: p.ticket_id });
});

export default app;
