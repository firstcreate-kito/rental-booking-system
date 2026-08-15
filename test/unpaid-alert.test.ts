import { describe, it, expect } from 'vitest';
import { unpaidAlertEmail, type OverdueBooking } from '../src/lib/email';

const bookings: OverdueBooking[] = [
  {
    bookingNumber: '20260815-001',
    spaceName: '名駅フリースペース',
    total: 9680,
    createdAt: '2026-08-07 03:00:00',
    paymentMethod: 'invoice',
    recipientName: '株式会社サンプル',
    customerEmail: 'demo@example.com',
  },
];

describe('unpaidAlertEmail', () => {
  it('件数と予約情報を含む', () => {
    const m = unpaidAlertEmail({ days: 7, bookings });
    expect(m.subject).toContain('7日以上');
    expect(m.subject).toContain('1 件');
    expect(m.html).toContain('20260815-001');
    expect(m.html).toContain('名駅フリースペース');
    expect(m.html).toContain('¥9,680');
    expect(m.html).toContain('株式会社サンプル');
    expect(m.text).toContain('2026-08-07');
  });
  it('HTMLエスケープされる', () => {
    const m = unpaidAlertEmail({ days: 7, bookings: [{ ...bookings[0], recipientName: '<b>x</b>' }] });
    expect(m.html).not.toContain('<b>x</b>');
    expect(m.html).toContain('&lt;b&gt;');
  });
});
