import { describe, it, expect } from 'vitest';
import { normalizeYmd } from '../src/lib/ticket-migration';

describe('normalizeYmd（valid_from の日付正規化ガード）', () => {
  it("'YYYYMMDD' はハイフン区切りに正規化する", () => {
    expect(normalizeYmd('20260830')).toBe('2026-08-30');
  });
  it("すでに 'YYYY-MM-DD' ならそのまま返す", () => {
    expect(normalizeYmd('2026-08-30')).toBe('2026-08-30');
  });
  it('前後の空白はトリムする', () => {
    expect(normalizeYmd('  20260830  ')).toBe('2026-08-30');
  });
  it('想定外の書式はそのまま返す（過度な変換をしない）', () => {
    expect(normalizeYmd('2026/08/30')).toBe('2026/08/30');
    expect(normalizeYmd('')).toBe('');
  });
  it("正規化後は当日判定 valid_from <= today が文字列比較で成立する", () => {
    // 不具合の核心：'20260830' <= '2026-09-04' は false（'0' > '-'）になっていた
    const validFrom = normalizeYmd('20260830');
    expect(validFrom <= '2026-09-04').toBe(true);
  });
});
