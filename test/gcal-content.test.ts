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

describe('カレンダー タイトル（サイネージ書式）', () => {
  it('本予約は【予約完了】＋名前｜スペース（平日/土日祝）／時間。spaceLabelを渡すとそれを使う', () => {
    // 外部サイネージがこの書式を解釈するため、半角/全角・空白を含め厳密一致で固定する
    expect(buildCalendarTitle(base, false, '名駅エクササイズスペース（平日）')).toBe(
      '【予約完了】 山田 太郎｜ 名駅エクササイズスペース（平日）／3時間',
    );
  });
  it('spaceLabel省略時はspaceNameをそのまま使う', () => {
    expect(buildCalendarTitle(base, false)).toBe('【予約完了】 山田 太郎｜ 名駅エクササイズスペース／3時間');
  });
  it('商談中は【商談中】', () => {
    expect(buildCalendarTitle(base, true)).toContain('【商談中】');
  });
});

describe('カレンダー 説明欄（サイネージ書式・Bookly互換）', () => {
  const d = buildCalendarDescription(base, 'https://space-albe.com', '名駅エクササイズスペース（平日）');
  it('上段の[キー]：値ブロック（サイネージ解釈用）', () => {
    expect(d).toContain('[スペース名]：名駅エクササイズスペース（平日）');
    expect(d).toContain('[利用目的]：レッスン');
    expect(d).toContain('[利用形態]：');
    expect(d).toContain('[イベント名]：姿勢と歩き方の教室');
    expect(d).toContain('[人数]：10');
    expect(d).toContain('[プラン]：名駅エクササイズスペース（平日）／3時間');
    // オプション：数量>1は「N x 名前」、カンマ区切り
    expect(d).toContain('[オプション]：5 x テーブル, 10 x 椅子');
  });
  it('下段の詳細（お名前/Eメール/電話番号は半角コロン）と管理画面リンク', () => {
    expect(d).toContain('お名前: 山田 太郎');
    expect(d).toContain('Eメール: yamada@example.com');
    expect(d).toContain('電話番号: 08045994501');
    expect(d).toContain('予約確認番号：20260901-007');
    expect(d).toContain('利用人数：10');
    expect(d).toContain('ご利用金額：¥20,240');
    expect(d).toContain('利用実績：利用経験あり');
    expect(d).toContain('管理画面リンク：https://space-albe.com/admin.html?booking=20260901-007');
  });
  it('初回利用・オプションなし・未入力項目は空欄。originなしなら管理画面リンクなし', () => {
    const d2 = buildCalendarDescription(
      { ...base, repeatCustomer: false, options: [], purpose: null, headcount: null, email: null },
      '',
    );
    expect(d2).toContain('利用実績：初回利用');
    expect(d2).toContain('[オプション]：');
    expect(d2).toContain('[利用目的]：\n'); // 空欄
    expect(d2).toContain('[人数]：\n');
    expect(d2).toContain('Eメール: \n');
    expect(d2).not.toContain('管理画面リンク：');
  });
});
