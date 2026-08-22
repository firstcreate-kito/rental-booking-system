import { describe, it, expect, vi, afterEach } from 'vitest';
import { refundPaymentAmount } from '../src/lib/stripe';
import { refundPaypalCapture, capturePaypalOrder } from '../src/lib/paypal';

afterEach(() => { vi.restoreAllMocks(); });

function mockFetch(status: number, json: unknown, capture?: (url: string, init: RequestInit) => void) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    // PayPal のOAuthトークン取得は常に成功させる（本題の capture/refund を試験するため）
    if (String(url).includes('/oauth2/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'test-token' }) } as Response;
    }
    if (capture) capture(url, init);
    return { ok: status >= 200 && status < 300, status, json: async () => json } as Response;
  }) as unknown as typeof fetch);
}

describe('refundPaymentAmount (Stripe)', () => {
  it('全額返金は amount を送らない', async () => {
    let sentBody = '';
    mockFetch(200, { id: 're_1' }, (_u, init) => { sentBody = String(init.body); });
    const r = await refundPaymentAmount('sk_test', 'pi_123');
    expect(r.ok).toBe(true);
    expect(r.refundId).toBe('re_1');
    expect(sentBody).toContain('payment_intent=pi_123');
    expect(sentBody).not.toContain('amount=');
  });

  it('一部返金は amount（円・整数）を送る', async () => {
    let sentBody = '';
    mockFetch(200, { id: 're_2' }, (_u, init) => { sentBody = String(init.body); });
    const r = await refundPaymentAmount('sk_test', 'pi_123', 1540);
    expect(r.ok).toBe(true);
    expect(sentBody).toContain('amount=1540');
  });

  it('0円以下の一部返金は弾く（全額返金との誤認防止）', async () => {
    const spy = mockFetch(200, { id: 're_x' });
    const r = await refundPaymentAmount('sk_test', 'pi_123', 0);
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('Stripeがエラーを返したら ok:false', async () => {
    mockFetch(400, { error: { message: 'charge already refunded' } });
    const r = await refundPaymentAmount('sk_test', 'pi_123');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('already refunded');
  });
});

describe('capturePaypalOrder / refundPaypalCapture', () => {
  it('キャプチャIDを取り出して返す', async () => {
    mockFetch(200, {
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ id: 'CAP-123' }] } }],
    });
    const r = await capturePaypalOrder({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }, 'ORDER-1');
    expect(r.completed).toBe(true);
    expect(r.captureId).toBe('CAP-123');
  });

  it('一部返金は JPY 金額を body に載せる', async () => {
    let sentBody = '';
    let calledUrl = '';
    mockFetch(200, { id: 'REF-1', status: 'COMPLETED' }, (u, init) => {
      // 1回目は oauth トークン取得なので、captures/refund の呼び出しだけ拾う
      if (String(u).includes('/refund')) { calledUrl = String(u); sentBody = String(init.body); }
    });
    const r = await refundPaypalCapture({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }, 'CAP-123', 1540);
    expect(r.ok).toBe(true);
    expect(r.refundId).toBe('REF-1');
    expect(calledUrl).toContain('/v2/payments/captures/CAP-123/refund');
    expect(sentBody).toContain('"currency_code":"JPY"');
    expect(sentBody).toContain('"value":"1540"');
  });

  it('全額返金は空 body（amount なし）', async () => {
    let sentBody = '{"x":1}';
    mockFetch(200, { id: 'REF-2', status: 'COMPLETED' }, (u, init) => {
      if (String(u).includes('/refund')) sentBody = String(init.body);
    });
    const r = await refundPaypalCapture({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }, 'CAP-9');
    expect(r.ok).toBe(true);
    expect(sentBody).toBe('{}');
  });

  it('0円以下は弾く', async () => {
    const r = await refundPaypalCapture({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }, 'CAP-9', -5);
    expect(r.ok).toBe(false);
  });
});
