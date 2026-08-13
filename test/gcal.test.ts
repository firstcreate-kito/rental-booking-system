import { describe, it, expect } from 'vitest';
import { gcalConfigured, toJstRfc3339, rangesOverlap, conflictsWithBusy } from '../src/lib/gcal';

describe('gcal - 設定判定', () => {
  it('両方セットで有効', () => {
    expect(gcalConfigured({ GOOGLE_SA_EMAIL: 'a@b', GOOGLE_SA_PRIVATE_KEY: 'k' })).toBe(true);
  });
  it('片方欠けたら無効', () => {
    expect(gcalConfigured({ GOOGLE_SA_EMAIL: 'a@b' })).toBe(false);
    expect(gcalConfigured({ GOOGLE_SA_PRIVATE_KEY: 'k' })).toBe(false);
    expect(gcalConfigured({})).toBe(false);
  });
});

describe('gcal - JST RFC3339 変換', () => {
  it('日付+時刻を+09:00付きに', () => {
    expect(toJstRfc3339('2026-09-10', '10:00')).toBe('2026-09-10T10:00:00+09:00');
  });
  it('HH:MM:SS が来ても HH:MM で切る', () => {
    expect(toJstRfc3339('2026-09-10', '10:00:00')).toBe('2026-09-10T10:00:00+09:00');
  });
});

describe('gcal - 重なり判定', () => {
  const s = (t: string) => `2026-09-10T${t}:00+09:00`;
  it('重なる', () => {
    expect(rangesOverlap(s('10:00'), s('12:00'), s('11:00'), s('13:00'))).toBe(true);
  });
  it('隣接（境界一致）は重ならない', () => {
    expect(rangesOverlap(s('10:00'), s('12:00'), s('12:00'), s('13:00'))).toBe(false);
  });
  it('完全に別時間は重ならない', () => {
    expect(rangesOverlap(s('10:00'), s('11:00'), s('13:00'), s('14:00'))).toBe(false);
  });
  it('conflictsWithBusy: busy群のどれかと重なれば true', () => {
    const busy = [
      { start: s('09:00'), end: s('10:00') },
      { start: s('13:00'), end: s('15:00') },
    ];
    expect(conflictsWithBusy(s('14:00'), s('16:00'), busy)).toBe(true);
    expect(conflictsWithBusy(s('10:00'), s('13:00'), busy)).toBe(false); // 隙間に収まる
  });
});
