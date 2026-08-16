import { describe, it, expect } from 'vitest';
import { computeFreeWindows, classifySpaceDay } from '../src/lib/availability';

describe('availability - computeFreeWindows（#74 空き時間帯）', () => {
  const open = '08:00', close = '22:00', slot = 30;
  it('予約なしなら終日1本の空き', () => {
    const w = computeFreeWindows([], open, close, slot);
    expect(w).toEqual([{ start: '08:00', end: '22:00' }]);
  });
  it('中抜けで2本に分割', () => {
    const w = computeFreeWindows([{ startTime: '13:00', endTime: '16:00', status: 'confirmed' }], open, close, slot);
    expect(w).toEqual([{ start: '08:00', end: '13:00' }, { start: '16:00', end: '22:00' }]);
  });
  it('終日埋まっていれば空きなし', () => {
    const w = computeFreeWindows([{ startTime: '08:00', endTime: '22:00', status: 'confirmed' }], open, close, slot);
    expect(w).toEqual([]);
  });
  it('キャンセル等の非占有ステータスは無視', () => {
    const w = computeFreeWindows([{ startTime: '10:00', endTime: '12:00', status: 'cancelled' }], open, close, slot);
    expect(w).toEqual([{ start: '08:00', end: '22:00' }]);
  });
});

describe('availability - classifySpaceDay（#74 グループ判定）', () => {
  const baseFuture = {
    dayAvailable: true,
    freeWindows: [{ start: '10:00', end: '13:00' }],
    hasTentative: false,
    dateYmd: '2026-09-01',
    todayYmd: '2026-08-16',
    earliestBookableDate: '2026-08-16',
    nowHHMM: '09:00',
    cutoffHours: 1,
  };
  it('未来日・空きあり・受付可 → ok', () => {
    expect(classifySpaceDay(baseFuture).group).toBe('ok');
  });
  it('商談中を含む → talk', () => {
    expect(classifySpaceDay({ ...baseFuture, hasTentative: true }).group).toBe('talk');
  });
  it('休業 → full', () => {
    expect(classifySpaceDay({ ...baseFuture, dayAvailable: false }).group).toBe('full');
  });
  it('空き0 → full（満室）', () => {
    expect(classifySpaceDay({ ...baseFuture, freeWindows: [] }).group).toBe('full');
  });
  it('締切前（earliestより手前の日）→ sameday（受付不可）', () => {
    // アルベホール等 deadline=1 の当日：today=earliest-1
    expect(classifySpaceDay({ ...baseFuture, dateYmd: '2026-08-16', earliestBookableDate: '2026-08-17' }).group).toBe('sameday');
  });
  it('当日・締切を過ぎている（残り枠が締切より前に終わる）→ sameday', () => {
    const today = {
      ...baseFuture,
      dateYmd: '2026-08-16',
      todayYmd: '2026-08-16',
      earliestBookableDate: '2026-08-16',
      nowHHMM: '12:30',
      cutoffHours: 1, // 締切=13:30。午前の枠しか残っていない
      freeWindows: [{ start: '08:00', end: '12:00' }],
    };
    expect(classifySpaceDay(today).group).toBe('sameday');
  });
  it('当日・締切以降まで続く枠があれば ok（枠開始が締切より前でも可）', () => {
    const today = {
      ...baseFuture,
      dateYmd: '2026-08-16',
      todayYmd: '2026-08-16',
      earliestBookableDate: '2026-08-16',
      nowHHMM: '12:00',
      cutoffHours: 1, // 締切=13:00。枠は8:00〜22:00 → 13:00以降に予約可能
      freeWindows: [{ start: '08:00', end: '22:00' }],
    };
    expect(classifySpaceDay(today).group).toBe('ok');
  });
});
