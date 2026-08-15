/**
 * Stripe 決済ユーティリティ（Checkout ホスト型 + Webhook 署名検証）
 *
 * - カード情報は Stripe がホストする決済ページで扱い、当システムは一切保持しない。
 * - チケット発行は「決済完了 Webhook（署名検証済み）」を唯一の正として行う。
 *   （成功URLへの戻りは表示用。発行の根拠にはしない＝改ざん耐性のため）
 */

export interface Env {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export function stripeConfigured(env: Env): boolean {
  return !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

export interface CheckoutParams {
  /** 商品名（Stripe の決済ページに表示） */
  productName: string;
  /** 金額（円・税込）。JPY はゼロ小数通貨なので unit_amount にそのまま渡す */
  amountJpy: number;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  /** 冪等・突合用メタデータ */
  metadata: Record<string, string>;
  /** 内部購入ID（client_reference_id） */
  clientReferenceId: string;
  /**
   * 決済手段の明示指定（#67）。未指定なら Stripe の自動判定（ダッシュボード設定）。
   * 例：['card']（カードのみ／コンビニ除外）、['card','konbini']（カード＋コンビニ）。
   */
  paymentMethodTypes?: string[];
  /** コンビニ払込票の有効期限（日）。konbini 指定時のみ有効。 */
  konbiniExpiresAfterDays?: number;
}

/**
 * Checkout Session の application/x-www-form-urlencoded ボディを組み立てる（純関数・テスト可能）。
 */
export function buildCheckoutBody(p: CheckoutParams): string {
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('success_url', p.successUrl);
  body.set('cancel_url', p.cancelUrl);
  body.set('client_reference_id', p.clientReferenceId);
  if (p.customerEmail) body.set('customer_email', p.customerEmail);
  body.set('line_items[0][quantity]', '1');
  body.set('line_items[0][price_data][currency]', 'jpy');
  body.set('line_items[0][price_data][unit_amount]', String(p.amountJpy));
  body.set('line_items[0][price_data][product_data][name]', p.productName);
  for (const [k, v] of Object.entries(p.metadata)) {
    body.set(`metadata[${k}]`, v);
    // payment_intent にもメタデータを引き継ぐ（照合用）
    body.set(`payment_intent_data[metadata][${k}]`, v);
  }
  // 決済手段を明示する場合（#67）。指定時は自動判定に頼らず列挙する。
  if (p.paymentMethodTypes && p.paymentMethodTypes.length) {
    p.paymentMethodTypes.forEach((t, i) => body.set(`payment_method_types[${i}]`, t));
    if (p.paymentMethodTypes.includes('konbini') && p.konbiniExpiresAfterDays) {
      body.set('payment_method_options[konbini][expires_after_days]', String(p.konbiniExpiresAfterDays));
    }
  }
  return body.toString();
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/** Stripe Checkout Session を作成し、決済ページの URL を返す。 */
export async function createCheckoutSession(secretKey: string, params: CheckoutParams): Promise<CheckoutSession> {
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: buildCheckoutBody(params),
  });
  const json = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !json.id || !json.url) {
    throw new Error(json.error?.message || `Stripe error (${res.status})`);
  }
  return { id: json.id, url: json.url };
}

// ---------------------------------------------------------------------------
// 銀行振込（customer_balance / jp_bank_transfer）#42
// ---------------------------------------------------------------------------

/**
 * Stripe Customer を作成して ID を返す。
 * customer_balance（銀行振込）の Checkout は Customer が必須のため。
 */
export async function createStripeCustomer(
  secretKey: string,
  info: { email?: string; name?: string },
): Promise<string> {
  const body = new URLSearchParams();
  if (info.email) body.set('email', info.email);
  if (info.name) body.set('name', info.name);
  const res = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok || !json.id) throw new Error(json.error?.message || `Stripe customer error (${res.status})`);
  return json.id;
}

export interface BankTransferCheckoutParams extends CheckoutParams {
  /** customer_balance は Customer 必須 */
  customerId: string;
}

/**
 * 銀行振込（jp_bank_transfer）の Checkout Session ボディを組み立てる（純関数・テスト可能）。
 * お客様には振込専用の仮想口座が案内され、入金確定は async_payment_succeeded で通知される。
 */
export function buildBankTransferBody(p: BankTransferCheckoutParams): string {
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('success_url', p.successUrl);
  body.set('cancel_url', p.cancelUrl);
  body.set('client_reference_id', p.clientReferenceId);
  body.set('customer', p.customerId);
  body.set('payment_method_types[0]', 'customer_balance');
  body.set('payment_method_options[customer_balance][funding_type]', 'bank_transfer');
  body.set('payment_method_options[customer_balance][bank_transfer][type]', 'jp_bank_transfer');
  body.set('line_items[0][quantity]', '1');
  body.set('line_items[0][price_data][currency]', 'jpy');
  body.set('line_items[0][price_data][unit_amount]', String(p.amountJpy));
  body.set('line_items[0][price_data][product_data][name]', p.productName);
  for (const [k, v] of Object.entries(p.metadata)) {
    body.set(`metadata[${k}]`, v);
    body.set(`payment_intent_data[metadata][${k}]`, v);
  }
  return body.toString();
}

/** 銀行振込の Checkout Session を作成し、案内ページ URL を返す。 */
export async function createBankTransferCheckout(
  secretKey: string,
  params: BankTransferCheckoutParams,
): Promise<CheckoutSession> {
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildBankTransferBody(params),
  });
  const json = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !json.id || !json.url) throw new Error(json.error?.message || `Stripe error (${res.status})`);
  return { id: json.id, url: json.url };
}

// ---------------------------------------------------------------------------
// Webhook 署名検証（Stripe-Signature: t=...,v1=...）
// ---------------------------------------------------------------------------
function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 一定時間比較（タイミング攻撃対策） */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Stripe-Signature ヘッダを検証し、検証OKなら parse 済みイベントを返す。
 * 失敗時は例外を投げる。now は秒（テスト用に注入可能）。
 */
export async function verifyStripeWebhook(
  payload: string,
  sigHeader: string | null | undefined,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): Promise<StripeEvent> {
  if (!sigHeader) throw new Error('署名ヘッダがありません');
  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  ) as Record<string, string>;
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) throw new Error('署名フォーマットが不正です');
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) {
    throw new Error('署名のタイムスタンプが期限外です');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = hex(mac);
  if (!timingSafeEqual(expected, v1)) throw new Error('署名が一致しません');
  return JSON.parse(payload) as StripeEvent;
}
