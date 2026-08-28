import { describe, it, expect } from 'vitest';
import { billableHours, loadBooklySlots, BOOKLY_TARGET_SPACES, type BooklySlot } from '../src/lib/bookly-import';

describe('billableHours', () => {
  it('60分=1時間', () => expect(billableHours(60)).toBe(1));
  it('120分=2時間', () => expect(billableHours(120)).toBe(2));
  it('150分=3時間（四捨五入・最低1）', () => expect(billableHours(150)).toBe(3));
  it('840分=14時間', () => expect(billableHours(840)).toBe(14));
  it('0/欠損は最低1', () => {
    expect(billableHours(0)).toBe(1);
    expect(billableHours(NaN)).toBe(1);
  });
});

describe('bookly-slots.json（取り込みデータの健全性）', () => {
  const slots = loadBooklySlots();
  const target = new Set<string>(BOOKLY_TARGET_SPACES);

  it('スロットが存在する', () => {
    expect(slots.length).toBeGreaterThan(0);
  });

  it('全スロットが対象8スペースのいずれか', () => {
    const bad = slots.filter((s) => !target.has(s.spaceId));
    expect(bad.map((b) => b.spaceId)).toEqual([]);
  });

  it('OTA行が混入していない（ラベルにポータル予約IDを含まない）', () => {
    const ota = slots.filter((s) => /スペースマーケット|インスタベース|予約ID:/.test(s.label));
    expect(ota).toEqual([]);
  });

  it('booklyKey が一意（＝重複排除済み）', () => {
    const keys = new Set(slots.map((s) => s.booklyKey));
    expect(keys.size).toBe(slots.length);
  });

  it('booklyKey は spaceId|date|start の形', () => {
    for (const s of slots) {
      expect(s.booklyKey).toBe(`${s.spaceId}|${s.date}|${s.startTime}`);
    }
  });

  it('日付・時刻が正しい形式で、終了が開始より後', () => {
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const timeRe = /^\d{2}:\d{2}$/;
    for (const s of slots) {
      expect(s.date, s.booklyKey).toMatch(dateRe);
      expect(s.startTime, s.booklyKey).toMatch(timeRe);
      expect(s.endTime, s.booklyKey).toMatch(timeRe);
      // 8スペースでは日跨ぎは発生しない想定（終了 > 開始）
      expect(s.endTime > s.startTime, `${s.booklyKey} end=${s.endTime}`).toBe(true);
    }
  });

  it('category は既知の値のみ', () => {
    const allowed = new Set<BooklySlot['category']>(['customer', 'customer_ticket', 'block', 'mirror']);
    for (const s of slots) expect(allowed.has(s.category), s.booklyKey).toBe(true);
  });

  it('durationMin>0・billable_hoursが1以上', () => {
    for (const s of slots) {
      expect(s.durationMin, s.booklyKey).toBeGreaterThan(0);
      expect(billableHours(s.durationMin)).toBeGreaterThanOrEqual(1);
    }
  });
});
