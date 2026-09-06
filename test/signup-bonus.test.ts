import { describe, it, expect } from 'vitest';
import { parseSpaceIds, buildSignupCouponPlan, type SignupBonusRuleRow } from '../src/lib/signup-bonus';

const baseRule: SignupBonusRuleRow = {
  id: 'r1',
  enabled: 1,
  name: '新規登録特典 ¥500クーポン',
  discount_type: 'fixed',
  discount_value: 500,
  total_hours: 1,
  validity_days: 30,
  space_ids: '["meieki-piano-a","meieki-piano-b","higashibetsuin-piano-24h"]',
};

describe('parseSpaceIds', () => {
  it('正しいJSON配列をパースする', () => {
    expect(parseSpaceIds('["a","b"]')).toEqual(['a', 'b']);
  });
  it('空配列・null・不正JSONは空配列', () => {
    expect(parseSpaceIds('[]')).toEqual([]);
    expect(parseSpaceIds(null)).toEqual([]);
    expect(parseSpaceIds('not json')).toEqual([]);
    expect(parseSpaceIds('{"x":1}')).toEqual([]);
  });
  it('文字列以外/空文字の要素は除外', () => {
    expect(parseSpaceIds('["a", 1, "", "b"]')).toEqual(['a', 'b']);
  });
});

describe('buildSignupCouponPlan', () => {
  it('有効ルールから発行内容を組み立て（期限=登録日+validity_days）', () => {
    const plan = buildSignupCouponPlan(baseRule, '2026-09-06');
    expect(plan).not.toBeNull();
    expect(plan!.discountType).toBe('fixed');
    expect(plan!.discountValue).toBe(500);
    expect(plan!.totalHours).toBe(1);
    expect(plan!.validFrom).toBe('2026-09-06');
    expect(plan!.validUntil).toBe('2026-10-06'); // +30日
    expect(plan!.spaceIds).toEqual(['meieki-piano-a', 'meieki-piano-b', 'higashibetsuin-piano-24h']);
    expect(plan!.source).toBe('signup');
  });
  it('enabled=0 は発行しない（null）', () => {
    expect(buildSignupCouponPlan({ ...baseRule, enabled: 0 }, '2026-09-06')).toBeNull();
  });
  it('割引額/時間が0以下は発行しない（null）', () => {
    expect(buildSignupCouponPlan({ ...baseRule, discount_value: 0 }, '2026-09-06')).toBeNull();
    expect(buildSignupCouponPlan({ ...baseRule, total_hours: 0 }, '2026-09-06')).toBeNull();
  });
  it('validity_days<=0 は既定30日にフォールバック', () => {
    const plan = buildSignupCouponPlan({ ...baseRule, validity_days: 0 }, '2026-09-06');
    expect(plan!.validUntil).toBe('2026-10-06');
  });
});
