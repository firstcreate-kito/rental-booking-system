import { describe, it, expect } from 'vitest';
import { gcalConfigured, toJstRfc3339, rangesOverlap, conflictsWithBusy, rfc3339ToJst, busyToDayInterval, calendarWritesSuppressed } from '../src/lib/gcal';

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

describe('gcal - ステージング書き込み抑止', () => {
  it('staging は既定で書き込み抑止（本番カレンダー汚染防止）', () => {
    expect(calendarWritesSuppressed({ APP_ENV: 'staging' })).toBe(true);
  });
  it('staging でも STAGING_ALLOW_CALENDAR=true なら書き込み許可', () => {
    expect(calendarWritesSuppressed({ APP_ENV: 'staging', STAGING_ALLOW_CALENDAR: 'true' })).toBe(false);
  });
  it('production / development は抑止しない', () => {
    expect(calendarWritesSuppressed({ APP_ENV: 'production' })).toBe(false);
    expect(calendarWritesSuppressed({ APP_ENV: 'development' })).toBe(false);
    expect(calendarWritesSuppressed({})).toBe(false);
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

describe('gcal - 読み取り（JST変換・日クランプ）', () => {
  it('rfc3339ToJst: +09:00 はそのまま', () => {
    expect(rfc3339ToJst('2026-08-20T10:00:00+09:00')).toEqual({ date: '2026-08-20', time: '10:00' });
  });
  it('rfc3339ToJst: UTC(Z) は+9時間', () => {
    expect(rfc3339ToJst('2026-08-20T01:00:00Z')).toEqual({ date: '2026-08-20', time: '10:00' });
  });
  it('busyToDayInterval: 同日はそのまま', () => {
    const iv = busyToDayInterval({ start: '2026-08-20T10:00:00+09:00', end: '2026-08-20T12:00:00+09:00' }, '2026-08-20', '22:00');
    expect(iv).toEqual({ startTime: '10:00', endTime: '12:00' });
  });
  it('busyToDayInterval: 対象日に無ければ null', () => {
    const iv = busyToDayInterval({ start: '2026-08-21T10:00:00+09:00', end: '2026-08-21T12:00:00+09:00' }, '2026-08-20', '22:00');
    expect(iv).toBeNull();
  });
  it('busyToDayInterval: 翌日跨ぎは営業終了に丸める', () => {
    const iv = busyToDayInterval({ start: '2026-08-20T21:00:00+09:00', end: '2026-08-21T02:00:00+09:00' }, '2026-08-20', '22:00');
    expect(iv).toEqual({ startTime: '21:00', endTime: '22:00' });
  });
});
