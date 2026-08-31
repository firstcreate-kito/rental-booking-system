import { describe, it, expect } from 'vitest';
import { toMinutes } from '../src/lib/time';
import { computeFreeWindows } from '../src/lib/availability';

// 回帰: close_time "24:00"（24時間営業スペースの表記ゆれ）で空き状況計算が落ちないこと。
// 以前は toMinutes("24:00") が out-of-range で throw し、/availability が 500 になっていた（新栄スペース）。
describe('24:00 の許容（空き状況の堅牢化）', () => {
  it('toMinutes("24:00") は 1440 を返す（throwしない）', () => {
    expect(toMinutes('24:00')).toBe(1440);
  });
  it('toMinutes は開始側の不正時刻は従来どおり弾く', () => {
    expect(() => toMinutes('25:00')).toThrow();
    expect(() => toMinutes('12:60')).toThrow();
  });
  it('computeFreeWindows は close_time "24:00" でも例外を出さず全枠空きを返す', () => {
    const w = computeFreeWindows([], '00:00', '24:00', 30);
    expect(w).toEqual([{ start: '00:00', end: '24:00' }]);
  });
});
