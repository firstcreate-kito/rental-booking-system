import { describe, it, expect } from 'vitest';
import { additionalChargeEmail } from '../src/lib/email';

describe('additionalChargeEmail', () => {
  it('金額・予約番号・お支払いリンクを含む', () => {
    const m = additionalChargeEmail({
      customerName: '山田 太郎',
      bookingNumber: 'ALBE-20260917-0001',
      spaceName: 'アルベホール名古屋',
      amount: 3630,
      payUrl: 'https://checkout.stripe.com/pay/cs_test_123',
      reason: '利用時間の延長分',
    });
    expect(m.subject).toContain('追加料金');
    expect(m.subject).toContain('ALBE-20260917-0001');
    expect(m.text).toContain('¥3,630');
    expect(m.text).toContain('https://checkout.stripe.com/pay/cs_test_123');
    expect(m.text).toContain('利用時間の延長分');
    expect(m.html).toContain('お支払いページへ進む');
    expect(m.html).toContain('cs_test_123');
  });

  it('理由が無くても壊れない', () => {
    const m = additionalChargeEmail({
      customerName: 'お客様',
      bookingNumber: 'ALBE-1',
      spaceName: 'A',
      amount: 1000,
      payUrl: 'https://x/y',
    });
    expect(m.text).toContain('¥1,000');
    expect(m.html).not.toContain('undefined');
  });
});
