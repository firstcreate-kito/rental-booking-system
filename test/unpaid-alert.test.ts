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

import { bookingConfirmationEmail } from '../src/lib/email';
describe('共通署名（#46）', () => {
  it('全テンプレートに署名フッターが付く', () => {
    const m = bookingConfirmationEmail({
      bookingNumber: '20260901-001', spaceName: 'テスト', eventName: 'ev',
      customerName: '山田', days: [{ date: '2026-09-01', startTime: '10:00', endTime: '11:00' }],
      total: 1100, status: 'confirmed',
    });
    expect(m.text).toContain('株式会社ファーストクリエイト');
    expect(m.text).toContain('rental@space-albe.com');
    expect(m.html).toContain('https://space-albe.com/');
    // 署名がメール末尾（フッター）に来ている
    expect(m.text.trim().endsWith('https://space-albe.com/')).toBe(true);
    // 旧クロージング「ください。\nレンタルスペースALBE」の重複が無い
    expect(m.text).not.toContain('ください。\nレンタルスペースALBE');
  });
});
