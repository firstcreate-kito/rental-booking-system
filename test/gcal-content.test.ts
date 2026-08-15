import { describe, it, expect } from 'vitest';
import { buildCalendarTitle, buildCalendarDescription } from '../src/lib/gcal-sync';
import type { BookingCalendarData } from '../src/db/repository';

const base: BookingCalendarData = {
  calendarId: 'cal@x',
  bookingNumber: '20260901-007',
  status: 'confirmed',
  spaceName: '名駅エクササイズスペース',
  customerName: '山田 太郎',
  phone: '08045994501',
  eventName: '姿勢と歩き方の教室',
  purpose: 'レッスン',
  headcount: 10,
  total: 20240,
  paymentStatus: 'paid',
  paymentMethod: 'stripe',
  repeatCustomer: true,
  options: [{ name: '土足利用', quantity: 1 }],
  rows: [{ id: 'b1', date: '2026-09-01', start_time: '13:00', end_time: '16:00', google_event_id: null }],
};

describe('カレンダー タイトル', () => {
  it('本予約は【予約完了】＋名前｜スペース／時間', () => {
    expect(buildCalendarTitle(base, false)).toBe('【予約完了】 山田 太郎｜ 名駅エクササイズスペース／3時間');
  });
  it('商談中は【商談中】', () => {
    expect(buildCalendarTitle(base, true)).toContain('【商談中】');
  });
});

describe('カレンダー 説明欄', () => {
  const d = buildCalendarDescription(base, 'https://space-albe.com');
  it('主要項目を含む', () => {
    expect(d).toContain('スペース名：名駅エクササイズスペース');
    expect(d).toContain('電話番号：08045994501');
    expect(d).toContain('予約確認番号：20260901-007');
    expect(d).toContain('イベント名：姿勢と歩き方の教室');
    expect(d).toContain('利用目的：レッスン');
    expect(d).toContain('利用人数：10');
    expect(d).toContain('オプション：土足利用×1');
    expect(d).toContain('ご利用金額：¥20,240');
    expect(d).toContain('支払いステータス：支払済（Stripe）');
    expect(d).toContain('利用実績：利用経験あり');
    expect(d).toContain('管理画面リンク：https://space-albe.com/admin.html?booking=20260901-007');
  });
  it('未入金・初回利用・オプションなしも表現できる', () => {
    const d2 = buildCalendarDescription(
      { ...base, paymentStatus: 'unpaid', paymentMethod: 'bank_transfer', repeatCustomer: false, options: [], purpose: null, headcount: null },
      '',
    );
    expect(d2).toContain('支払いステータス：未入金（銀行振込）');
    expect(d2).toContain('利用実績：初回利用');
    expect(d2).toContain('オプション：なし');
    expect(d2).not.toContain('利用目的：');
    expect(d2).not.toContain('管理画面リンク：');
  });
});
