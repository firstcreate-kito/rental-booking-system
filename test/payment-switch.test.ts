import { describe, it, expect } from 'vitest';
import { isCardSwitchEligible } from '../src/lib/payment-switch';

describe('isCardSwitchEligible（カード決済への切替可否）', () => {
  it('確定・未入金・金額あり＝対象（銀行振込/コンビニ/請求書払いの入金待ち）', () => {
    expect(isCardSwitchEligible({ status: 'confirmed', payment_status: 'unpaid', total_amount: 6000 })).toBe(true);
  });
  it('入金済み＝対象外', () => {
    expect(isCardSwitchEligible({ status: 'confirmed', payment_status: 'paid', total_amount: 6000 })).toBe(false);
  });
  it('¥0（チケット等）＝対象外', () => {
    expect(isCardSwitchEligible({ status: 'confirmed', payment_status: 'unpaid', total_amount: 0 })).toBe(false);
  });
  it('pending（カード決済中）＝対象外', () => {
    expect(isCardSwitchEligible({ status: 'pending', payment_status: 'unpaid', total_amount: 6000 })).toBe(false);
  });
  it('cancelled＝対象外', () => {
    expect(isCardSwitchEligible({ status: 'cancelled', payment_status: 'unpaid', total_amount: 6000 })).toBe(false);
  });
});
