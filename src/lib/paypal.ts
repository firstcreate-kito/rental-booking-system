/**
 * PayPal 決済ユーティリティ（Orders API v2 / リダイレクト承認 → サーバでキャプチャ）
 *
 * フロー：
 *  1) createPaypalOrder で注文を作成 → 承認URL(approveUrl)へお客様を誘導
 *  2) お客様がPayPalで承認 → return_url へ戻る（?token=ORDER_ID が付与される）
 *  3) capturePaypalOrder でサーバ側から代金を確定（capture）
 */

export interface Env {
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_MODE?: string; // 'sandbox'（既定）/ 'live'
}

export function paypalConfigured(env: Env): boolean {
  return !!(env.PAYPAL_CLIENT_ID?.trim() && env.PAYPAL_CLIENT_SECRET?.trim());
}

export function paypalBaseUrl(env: Env): string {
  return env.PAYPAL_MODE?.trim() === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

export interface OrderParams {
  amountJpy: number;
  referenceId: string; // 予約グループID等（当システムの照合用）
  invoiceId: string; // 一意な請求ID（重複キャプチャ防止）
  returnUrl: string;
  cancelUrl: string;
  brandName?: string;
}

/** 注文作成リクエストボディを組み立てる（純関数・テスト可能）。JPYはゼロ小数通貨。 */
export function buildOrderBody(p: OrderParams): Record<string, unknown> {
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: p.referenceId,
        invoice_id: p.invoiceId,
        amount: { currency_code: 'JPY', value: String(Math.round(p.amountJpy)) },
      },
    ],
    application_context: {
      return_url: p.returnUrl,
      cancel_url: p.cancelUrl,
      user_action: 'PAY_NOW',
      brand_name: p.brandName ?? 'レンタルスペースALBE',
      shipping_preference: 'NO_SHIPPING',
    },
  };
}

/** OAuth2 クライアントクレデンシャルでアクセストークンを取得 */
async function getAccessToken(env: Env): Promise<string> {
  // 貼り付け時に混入しがちな前後の空白・改行を除去してから認証（invalid_client 対策）
  const id = (env.PAYPAL_CLIENT_ID ?? '').trim();
  const secret = (env.PAYPAL_CLIENT_SECRET ?? '').trim();
  const auth = btoa(`${id}:${secret}`);
  const res = await fetch(`${paypalBaseUrl(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !j.access_token) throw new Error(j.error_description || `PayPal auth error (${res.status})`);
  return j.access_token;
}

/** 注文を作成し、承認URLと注文IDを返す */
export async function createPaypalOrder(env: Env, p: OrderParams): Promise<{ orderId: string; approveUrl: string }> {
  const token = await getAccessToken(env);
  const res = await fetch(`${paypalBaseUrl(env)}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildOrderBody(p)),
  });
  const j = (await res.json()) as { id?: string; message?: string; links?: Array<{ rel: string; href: string }> };
  if (!res.ok || !j.id) throw new Error(j.message || `PayPal order error (${res.status})`);
  const approve = (j.links || []).find((l) => l.rel === 'approve');
  if (!approve) throw new Error('PayPal approve link missing');
  return { orderId: j.id, approveUrl: approve.href };
}

/**
 * 注文をキャプチャ（代金確定）。COMPLETED なら completed=true。
 * 返金に必要な「キャプチャID」も取り出して返す（後日の承認返金で使用）。
 */
export async function capturePaypalOrder(
  env: Env,
  orderId: string,
): Promise<{ completed: boolean; status: string; captureId?: string }> {
  const token = await getAccessToken(env);
  const res = await fetch(`${paypalBaseUrl(env)}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const j = (await res.json()) as {
    status?: string;
    message?: string;
    purchase_units?: Array<{ payments?: { captures?: Array<{ id?: string }> } }>;
  };
  if (!res.ok) throw new Error(j.message || `PayPal capture error (${res.status})`);
  const captureId = j.purchase_units?.[0]?.payments?.captures?.[0]?.id;
  return { completed: j.status === 'COMPLETED', status: j.status || 'UNKNOWN', captureId };
}

/**
 * キャプチャ済みの決済を返金する（一部返金対応）。amountJpy 省略で全額返金。
 * PayPal Payments API: POST /v2/payments/captures/{capture_id}/refund
 * 成功可否と返金IDを返す（失敗しても例外にせず ok:false）。
 */
export async function refundPaypalCapture(
  env: Env,
  captureId: string,
  amountJpy?: number,
): Promise<{ ok: boolean; refundId?: string; error?: string }> {
  try {
    const token = await getAccessToken(env);
    const body: Record<string, unknown> = {};
    if (amountJpy != null) {
      const amt = Math.round(amountJpy);
      if (!(amt > 0)) return { ok: false, error: 'invalid refund amount' };
      body.amount = { currency_code: 'JPY', value: String(amt) };
    }
    const res = await fetch(`${paypalBaseUrl(env)}/v2/payments/captures/${captureId}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { id?: string; status?: string; message?: string };
    if (!res.ok || !j.id) return { ok: false, error: j.message || `PayPal refund error (${res.status})` };
    return { ok: true, refundId: j.id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
