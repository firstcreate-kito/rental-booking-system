import { describe, it, expect } from 'vitest';
import { buildCheckoutBody, buildBankTransferBody, verifyStripeWebhook } from '../src/lib/stripe';

describe('buildBankTransferBody', () => {
  it('customer_balance / jp_bank_transfer の必須パラメータを含む', () => {
    const body = buildBankTransferBody({
      productName: 'ご予約 20260901-001',
      amountJpy: 9680,
      successUrl: 'https://x/ok',
      cancelUrl: 'https://x/ng',
      customerId: 'cus_123',
      clientReferenceId: 'pay1',
      metadata: { kind: 'booking', groupId: 'g1' },
    });
    const p = new URLSearchParams(body);
    expect(p.get('mode')).toBe('payment');
    expect(p.get('customer')).toBe('cus_123');
    expect(p.get('payment_method_types[0]')).toBe('customer_balance');
    expect(p.get('payment_method_options[customer_balance][funding_type]')).toBe('bank_transfer');
    expect(p.get('payment_method_options[customer_balance][bank_transfer][type]')).toBe('jp_bank_transfer');
    expect(p.get('line_items[0][price_data][currency]')).toBe('jpy');
    expect(p.get('line_items[0][price_data][unit_amount]')).toBe('9680');
    expect(p.get('metadata[groupId]')).toBe('g1');
  });
});

/** テスト内で正しい Stripe-Signature ヘッダを生成する（本番の Stripe と同じ HMAC-SHA256） */
async function signPayload(payload: string, secret: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${hex}`;
}

describe('buildCheckoutBody', () => {
  it('JPY はゼロ小数通貨として unit_amount にそのまま渡す', () => {
    const body = buildCheckoutBody({
      productName: 'テスト回数券',
      amountJpy: 7700,
      successUrl: 'https://x/success',
      cancelUrl: 'https://x/cancel',
      clientReferenceId: 'pur_1',
      metadata: { productId: 'tkp-1', customerId: 'c1' },
    });
    const params = new URLSearchParams(body);
    expect(params.get('mode')).toBe('payment');
    expect(params.get('line_items[0][price_data][currency]')).toBe('jpy');
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('7700');
    expect(params.get('line_items[0][price_data][product_data][name]')).toBe('テスト回数券');
    expect(params.get('metadata[productId]')).toBe('tkp-1');
    expect(params.get('payment_intent_data[metadata][customerId]')).toBe('c1');
    expect(params.get('client_reference_id')).toBe('pur_1');
  });
});

describe('verifyStripeWebhook', () => {
  const secret = 'whsec_test_123';
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

  it('正しい署名を検証してイベントを返す', async () => {
    const now = 1_700_000_000;
    const header = await signPayload(payload, secret, now);
    const event = await verifyStripeWebhook(payload, header, secret, now);
    expect(event.type).toBe('checkout.session.completed');
    expect((event.data.object as { id: string }).id).toBe('cs_1');
  });

  it('改ざんされたペイロードを拒否する', async () => {
    const now = 1_700_000_000;
    const header = await signPayload(payload, secret, now);
    await expect(verifyStripeWebhook(payload + 'x', header, secret, now)).rejects.toThrow();
  });

  it('誤ったシークレットを拒否する', async () => {
    const now = 1_700_000_000;
    const header = await signPayload(payload, secret, now);
    await expect(verifyStripeWebhook(payload, header, 'whsec_wrong', now)).rejects.toThrow();
  });

  it('期限切れタイムスタンプを拒否する', async () => {
    const signedAt = 1_700_000_000;
    const header = await signPayload(payload, secret, signedAt);
    // 10分後に検証（許容300秒を超過）
    await expect(verifyStripeWebhook(payload, header, secret, signedAt + 600)).rejects.toThrow();
  });

  it('署名ヘッダ欠落を拒否する', async () => {
    await expect(verifyStripeWebhook(payload, null, secret)).rejects.toThrow();
  });
});
