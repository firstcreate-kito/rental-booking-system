import { describe, it, expect } from 'vitest';
import {
  startTimesFromWindows,
  commonViewingStartTimes,
  bookingStatusLabel,
  type SpaceDayInput,
} from '../src/lib/viewing';

describe('startTimesFromWindows', () => {
  it('30分刻みで開始時刻を並べる（duration=30）', () => {
    expect(startTimesFromWindows([{ start: '10:00', end: '12:00' }])).toEqual([
      '10:00',
      '10:30',
      '11:00',
      '11:30',
    ]);
  });

  it('窓の末尾は duration が収まる開始まで（12:00終わりに11:30まで）', () => {
    expect(startTimesFromWindows([{ start: '11:00', end: '12:00' }])).toEqual(['11:00', '11:30']);
  });

  it('グリッド外の開始は切り上げる（10:15→10:30から）', () => {
    expect(startTimesFromWindows([{ start: '10:15', end: '11:30' }])).toEqual(['10:30', '11:00']);
  });

  it('30分未満の窓は候補なし', () => {
    expect(startTimesFromWindows([{ start: '10:00', end: '10:20' }])).toEqual([]);
  });
});

describe('commonViewingStartTimes', () => {
  const open = '10:00';
  const close = '18:00';
  const mk = (occ: Array<[string, string, string]>): SpaceDayInput => ({
    occupying: occ.map(([startTime, endTime, status]) => ({ startTime, endTime, status })),
    openTime: open,
    closeTime: close,
  });

  it('予約なし1施設は全枠が候補', () => {
    const r = commonViewingStartTimes([mk([])]);
    expect(r[0]).toBe('10:00');
    expect(r[r.length - 1]).toBe('17:30'); // 18:00終わりに30分収まる最後
  });

  it('confirmed も tentative も除外する', () => {
    // 13:00-14:00 confirmed, 15:00-15:30 tentative を塞ぐ
    const r = commonViewingStartTimes([mk([['13:00', '14:00', 'confirmed'], ['15:00', '15:30', 'tentative']])]);
    expect(r).not.toContain('13:00');
    expect(r).not.toContain('13:30');
    expect(r).not.toContain('15:00');
    expect(r).toContain('12:30'); // 12:30-13:00 は空き
    expect(r).toContain('14:00');
  });

  it('複数施設は共通で空いている枠のみ（積集合）', () => {
    // A: 13:00-14:00 埋まり / B: 11:00-12:00 埋まり
    const a = mk([['13:00', '14:00', 'confirmed']]);
    const b = mk([['11:00', '12:00', 'confirmed']]);
    const r = commonViewingStartTimes([a, b]);
    // どちらかで埋まっている時間は共通枠から除外
    expect(r).not.toContain('11:00'); // Bで埋まり
    expect(r).not.toContain('11:30'); // Bで埋まり（11:30-12:00）
    expect(r).not.toContain('13:00'); // Aで埋まり
    expect(r).not.toContain('13:30'); // Aで埋まり
    expect(r).toContain('10:00'); // 両方空き
    expect(r).toContain('14:00'); // 両方空き
    expect(r).toContain('12:00'); // 両方空き
  });

  it('営業時間が異なる施設は狭い方に合わせる', () => {
    const a: SpaceDayInput = { occupying: [], openTime: '10:00', closeTime: '18:00' };
    const b: SpaceDayInput = { occupying: [], openTime: '13:00', closeTime: '15:00' };
    const r = commonViewingStartTimes([a, b]);
    expect(r).toEqual(['13:00', '13:30', '14:00', '14:30']);
  });

  it('1施設でも休業なら候補なし', () => {
    const a: SpaceDayInput = { occupying: [], openTime: '10:00', closeTime: '18:00' };
    const b: SpaceDayInput = { occupying: [], openTime: '10:00', closeTime: '18:00', closed: true };
    expect(commonViewingStartTimes([a, b])).toEqual([]);
  });

  it('施設0件は空', () => {
    expect(commonViewingStartTimes([])).toEqual([]);
  });
});

describe('bookingStatusLabel', () => {
  it('日本語ラベルに変換', () => {
    expect(bookingStatusLabel('booked')).toBe('予約済み');
    expect(bookingStatusLabel('considering')).toBe('予約検討中');
    expect(bookingStatusLabel('other')).toBe('その他');
  });
});
