import { describe, it, expect } from 'vitest';
import {
  subtractYears,
  anonymizationCutoff,
  isEligibleForAnonymization,
  RETENTION_YEARS,
} from '../src/lib/retention';

describe('retention - subtractYears', () => {
  it('年のみ減算し、月日は据え置く', () => {
    expect(subtractYears('2026-08-15', 7)).toBe('2019-08-15');
    expect(subtractYears('2026-01-01', 7)).toBe('2019-01-01');
    expect(subtractYears('2026-12-31', 7)).toBe('2019-12-31');
  });
  it('2/29 も文字列境界としてそのまま扱う', () => {
    expect(subtractYears('2028-02-29', 7)).toBe('2021-02-29');
  });
});

describe('retention - anonymizationCutoff', () => {
  it('today から RETENTION_YEARS 年前を返す', () => {
    expect(anonymizationCutoff('2026-08-15')).toBe('2019-08-15');
    expect(RETENTION_YEARS).toBe(7);
  });
});

describe('retention - isEligibleForAnonymization', () => {
  const cutoff = anonymizationCutoff('2026-08-15'); // 2019-08-15

  it('最終利用日が締切以前・未来予約なし → 対象', () => {
    expect(isEligibleForAnonymization({ lastUseDate: '2019-05-01', createdDate: '2018-01-01', futureActiveCount: 0 }, cutoff)).toBe(true);
  });
  it('最終利用日が締切ちょうど（境界含む） → 対象', () => {
    expect(isEligibleForAnonymization({ lastUseDate: '2019-08-15', createdDate: '2018-01-01', futureActiveCount: 0 }, cutoff)).toBe(true);
  });
  it('最終利用日が締切より後 → 対象外', () => {
    expect(isEligibleForAnonymization({ lastUseDate: '2019-08-16', createdDate: '2010-01-01', futureActiveCount: 0 }, cutoff)).toBe(false);
  });
  it('未来の有効予約がある → 起点が古くても対象外', () => {
    expect(isEligibleForAnonymization({ lastUseDate: '2019-01-01', createdDate: '2010-01-01', futureActiveCount: 1 }, cutoff)).toBe(false);
  });
  it('予約が一度も無ければ登録日を起点にする（古ければ対象）', () => {
    expect(isEligibleForAnonymization({ lastUseDate: null, createdDate: '2018-01-01', futureActiveCount: 0 }, cutoff)).toBe(true);
  });
  it('予約なし・登録日が新しい → 対象外', () => {
    expect(isEligibleForAnonymization({ lastUseDate: null, createdDate: '2024-01-01', futureActiveCount: 0 }, cutoff)).toBe(false);
  });
});
