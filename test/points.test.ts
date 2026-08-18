import { describe, it, expect } from 'vitest';
import { pointsForAmount, pointExpiryStatus } from '../src/lib/points';

describe('points - pointExpiryStatus（#78 有効期限・1年ローリング）', () => {
  it('最終活動から1年後が有効期限日', () => {
    expect(pointExpiryStatus('2026-01-01', '2026-06-01').expiryDate).toBe('2027-01-01');
  });
  it('期限まで31日以上先 → none', () => {
    const r = pointExpiryStatus('2026-01-01', '2026-11-01'); // 期限2027-01-01まで61日
    expect(r.action).toBe('none');
  });
  it('期限30日前ちょうど → notice', () => {
    const r = pointExpiryStatus('2026-01-01', '2026-12-02'); // 2027-01-01まで30日
    expect(r.daysUntil).toBe(30);
    expect(r.action).toBe('notice');
  });
  it('期限当日（残り0日）→ notice（まだ有効）', () => {
    const r = pointExpiryStatus('2026-01-01', '2027-01-01');
    expect(r.daysUntil).toBe(0);
    expect(r.action).toBe('notice');
  });
  it('期限翌日（残り-1日）→ expire', () => {
    const r = pointExpiryStatus('2026-01-01', '2027-01-02');
    expect(r.daysUntil).toBe(-1);
    expect(r.action).toBe('expire');
  });
  it('活動で期限が延長される（ローリング）', () => {
    // 同じ本日でも、最終活動が後ろにずれれば期限も延び、失効しない
    expect(pointExpiryStatus('2026-01-01', '2027-06-01').action).toBe('expire');
    expect(pointExpiryStatus('2027-05-01', '2027-06-01').action).toBe('none');
  });
});

describe('points - pointsForAmount（#70 獲得ポイント計算）', () => {
  it('1%還元：端数は切り捨て', () => {
    expect(pointsForAmount(21780, 1)).toBe(217);
    expect(pointsForAmount(10000, 1)).toBe(100);
    expect(pointsForAmount(9999, 1)).toBe(99);
  });
  it('率を変えられる（将来の調整用）', () => {
    expect(pointsForAmount(10000, 2)).toBe(200);
    expect(pointsForAmount(10000, 0.5)).toBe(50);
    expect(pointsForAmount(10000, 5)).toBe(500);
  });
  it('0円・0%・負値は0ポイント', () => {
    expect(pointsForAmount(0, 1)).toBe(0);
    expect(pointsForAmount(10000, 0)).toBe(0);
    expect(pointsForAmount(-5000, 1)).toBe(0);
    expect(pointsForAmount(10000, -1)).toBe(0);
  });
  it('少額で1%未満なら0ポイント（切り捨て）', () => {
    expect(pointsForAmount(50, 1)).toBe(0); // 0.5 → 0
    expect(pointsForAmount(99, 1)).toBe(0);
    expect(pointsForAmount(100, 1)).toBe(1);
  });
});
