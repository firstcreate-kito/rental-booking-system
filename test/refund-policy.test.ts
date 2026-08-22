import { describe, it, expect } from 'vitest';
import { refundModeFor, isManualRefund, maxRefundable, validateRefundAmount } from '../src/lib/refund-policy';

describe('refundModeFor', () => {
  it('カード(Stripe)は自動返金', () => {
    expect(refundModeFor('stripe')).toBe('auto_stripe');
    expect(refundModeFor('stripe', 'card')).toBe('auto_stripe');
  });
  it('コンビニ(stripe+konbini)は手動', () => {
    expect(refundModeFor('stripe', 'konbini')).toBe('manual');
    expect(isManualRefund('stripe', 'konbini')).toBe(true);
  });
  it('PayPalは自動返金', () => {
    expect(refundModeFor('paypal')).toBe('auto_paypal');
  });
  it('銀行振込・請求書は手動', () => {
    expect(refundModeFor('bank_transfer')).toBe('manual');
    expect(refundModeFor('invoice')).toBe('manual');
  });
  it('null/未知は手動（安全側）', () => {
    expect(refundModeFor(null)).toBe('manual');
    expect(refundModeFor(undefined)).toBe('manual');
    expect(refundModeFor('unknown')).toBe('manual');
  });
});

describe('maxRefundable', () => {
  it('paid のとき 入金額-返金済み', () => {
    expect(maxRefundable('paid', 10000, 0)).toBe(10000);
    expect(maxRefundable('paid', 10000, 3000)).toBe(7000);
  });
  it('返金済みが上回っても負にならない', () => {
    expect(maxRefundable('paid', 10000, 12000)).toBe(0);
  });
  it('未入金・請求書未払いは0', () => {
    expect(maxRefundable('unpaid', 10000, 0)).toBe(0);
    expect(maxRefundable('invoice', 10000, 0)).toBe(0);
  });
});

describe('validateRefundAmount', () => {
  it('1円以上・上限以下ならOK', () => {
    expect(validateRefundAmount(5000, 10000).ok).toBe(true);
    expect(validateRefundAmount(10000, 10000).ok).toBe(true);
  });
  it('0以下は不可', () => {
    expect(validateRefundAmount(0, 10000).ok).toBe(false);
    expect(validateRefundAmount(-1, 10000).ok).toBe(false);
  });
  it('上限超過は不可', () => {
    const r = validateRefundAmount(10001, 10000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('返金可能額');
  });
  it('数値でないものは不可', () => {
    expect(validateRefundAmount(NaN, 10000).ok).toBe(false);
  });
});
