import { describe, it, expect } from 'vitest';
import { pointsForAmount } from '../src/lib/points';

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
