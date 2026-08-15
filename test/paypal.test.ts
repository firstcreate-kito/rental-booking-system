import { describe, it, expect } from 'vitest';
import { buildOrderBody, paypalConfigured, paypalBaseUrl } from '../src/lib/paypal';

describe('buildOrderBody', () => {
  it('JPYはゼロ小数通貨として整数文字列で渡す', () => {
    const b = buildOrderBody({
      amountJpy: 1540,
      referenceId: 'grp1',
      invoiceId: 'inv1',
      returnUrl: 'https://x/return',
      cancelUrl: 'https://x/cancel',
    }) as any;
    expect(b.intent).toBe('CAPTURE');
    expect(b.purchase_units[0].amount.currency_code).toBe('JPY');
    expect(b.purchase_units[0].amount.value).toBe('1540'); // 小数点なし
    expect(b.purchase_units[0].reference_id).toBe('grp1');
    expect(b.purchase_units[0].invoice_id).toBe('inv1');
    expect(b.application_context.return_url).toBe('https://x/return');
    expect(b.application_context.cancel_url).toBe('https://x/cancel');
    expect(b.application_context.shipping_preference).toBe('NO_SHIPPING');
  });

  it('端数は丸めて整数文字列にする', () => {
    const b = buildOrderBody({ amountJpy: 1540.6, referenceId: 'g', invoiceId: 'i', returnUrl: 'r', cancelUrl: 'c' }) as any;
    expect(b.purchase_units[0].amount.value).toBe('1541');
  });
});

describe('paypalConfigured / baseUrl', () => {
  it('両方セットで有効', () => {
    expect(paypalConfigured({})).toBe(false);
    expect(paypalConfigured({ PAYPAL_CLIENT_ID: 'a' })).toBe(false);
    expect(paypalConfigured({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' })).toBe(true);
  });
  it('MODEでベースURLを切り替える', () => {
    expect(paypalBaseUrl({})).toContain('sandbox');
    expect(paypalBaseUrl({ PAYPAL_MODE: 'live' })).toBe('https://api-m.paypal.com');
  });
});
