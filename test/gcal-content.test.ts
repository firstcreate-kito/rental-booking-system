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
  email: 'yamada@example.com',
  company: '株式会社サンプル',
  eventName: '姿勢と歩き方の教室',
  purpose: 'レッスン',
  headcount: 10,
  total: 20240,
  paymentStatus: 'paid',
  paymentMethod: 'stripe',
  repeatCustomer: true,
  options: [{ name: 'テーブル', quantity: 5 }, { name: '椅子', quantity: 10 }],
  rows: [{ id: 'b1', date: '2026-09-01', start_time: '13:00', end_time: '16:00', google_event_id: null }],
};

describe('カレンダー タイトル', () => {
  it('本予約は【予約完了】＋名前｜スペース／時間（全角｜／・半角スペースを厳密に保つ）', () => {
    // 外部サイネージがこの書式を解釈するため、半角/全角・空白を含め厳密一致で固定する
    expect(buildCalendarTitle(base, false)).toBe('【予約完了】 山田 太郎｜ 名駅エクササイズスペース／3時間');
  });
  it('商談中は【商談中】', () => {
    expect(buildCalendarTitle(base, true)).toContain('【商談中】');
  });
});

describe('カレンダー 説明欄', () => {
  const d = buildCalendarDescription(base, 'https://space-albe.com');
  it('指定された基本情報を含む', () => {
    expect(d).toContain('予約番号：20260901-007');
    expect(d).toContain('イベント名：姿勢と歩き方の教室');
    expect(d).toContain('利用目的：レッスン');
    expect(d).toContain('ご利用人数：10名');
    expect(d).toContain('過去のご利用実績：利用経験あり');
    expect(d).toContain('オプション：テーブル×5／椅子×10');
    expect(d).toContain('メールアドレス：yamada@example.com');
    expect(d).toContain('電話番号：08045994501');
    expect(d).toContain('会社名：株式会社サンプル');
    expect(d).toContain('支払い方法：クレジットカード／コンビニ払い');
    expect(d).toContain('支払いステータス：完了');
    expect(d).toContain('管理画面リンク：https://space-albe.com/admin.html?booking=20260901-007');
  });
  it('未入金・初回利用・オプションなし・未入力項目も表現できる', () => {
    const d2 = buildCalendarDescription(
      {
        ...base,
        paymentStatus: 'unpaid',
        paymentMethod: 'bank_transfer',
        repeatCustomer: false,
        options: [],
        purpose: null,
        headcount: null,
        email: null,
        company: null,
      },
      '',
    );
    expect(d2).toContain('支払い方法：銀行振込');
    expect(d2).toContain('支払いステータス：入金待ち');
    expect(d2).toContain('過去のご利用実績：初回利用');
    expect(d2).toContain('オプション：なし');
    expect(d2).toContain('利用目的：—');
    expect(d2).toContain('ご利用人数：—');
    expect(d2).toContain('メールアドレス：—');
    expect(d2).toContain('会社名：—');
    expect(d2).not.toContain('管理画面リンク：');
  });
});
