import { describe, it, expect } from 'vitest';
import { applyDiscounts, resolveCampaign, type DiscountableDay, type CampaignCandidate } from '../src/lib/discounts';

// 名駅フリースペース想定: 平日 4840/h, 土日祝 7260/h
const weekdayDay = (hours: number): DiscountableDay => ({ billableHours: hours, price: hours * 4840 });
const weekendDay = (hours: number): DiscountableDay => ({ billableHours: hours, price: hours * 7260 });

describe('applyDiscounts - 割引なし', () => {
  it('スペース料金 + オプション（割引なし）', () => {
    const r = applyDiscounts({ days: [weekdayDay(3)], primary: { kind: 'none' }, optionsTotal: 2000 });
    expect(r.spaceFee).toBe(14520);
    expect(r.total).toBe(16520);
    expect(r.pointsEarned).toBe(165); // 1%
  });
});

describe('applyDiscounts - クーポン', () => {
  it('①残時間内: 20%OFF・残5h で 3h予約 → 全額に20%OFF', () => {
    const r = applyDiscounts({
      days: [weekdayDay(3)],
      primary: { kind: 'coupon', discountType: 'percent', discountValue: 20, remainingHours: 5 },
    });
    expect(r.couponHoursConsumed).toBe(3);
    expect(r.primaryDiscount).toBe(Math.round(14520 * 0.2)); // 2904
    expect(r.total).toBe(14520 - 2904); // 11616
  });

  it('①残時間超過: 20%OFF・残5h で 7h予約 → 5h分だけ割引、超過2hは満額', () => {
    const r = applyDiscounts({
      days: [weekdayDay(7)],
      primary: { kind: 'coupon', discountType: 'percent', discountValue: 20, remainingHours: 5 },
    });
    // 高い方から充当だが単一単価なので 5h分 = 5*4840=24200 に20%
    expect(r.couponHoursConsumed).toBe(5);
    expect(r.primaryDiscount).toBe(Math.round(24200 * 0.2)); // 4840
    expect(r.spaceFee).toBe(7 * 4840); // 33880
    expect(r.total).toBe(33880 - 4840); // 29040
  });

  it('クーポン利用時はキャンペーン不可', () => {
    const r = applyDiscounts({
      days: [weekdayDay(3)],
      primary: { kind: 'coupon', discountType: 'percent', discountValue: 20, remainingHours: 5 },
      campaign: { discountType: 'percent', discountValue: 10 },
    });
    expect(r.campaignDiscount).toBe(0);
  });

  it('固定額クーポンは充当対象額を上限に控除', () => {
    const r = applyDiscounts({
      days: [weekdayDay(1)], // 4840
      primary: { kind: 'coupon', discountType: 'fixed', discountValue: 6000, remainingHours: 5 },
    });
    expect(r.primaryDiscount).toBe(4840); // 上限
    expect(r.total).toBe(0);
  });
});

describe('applyDiscounts - チケット', () => {
  it('②残2hチケットで5h予約 → 2h¥0、超過3h満額', () => {
    const r = applyDiscounts({
      days: [weekdayDay(5)],
      primary: { kind: 'ticket', remainingHours: 2 },
    });
    expect(r.ticketHoursConsumed).toBe(2);
    expect(r.primaryDiscount).toBe(2 * 4840); // 9680
    expect(r.total).toBe(5 * 4840 - 9680); // 3*4840 = 14520
  });

  it('②チケット+キャンペーン: 超過分にのみキャンペーン適用', () => {
    const r = applyDiscounts({
      days: [weekdayDay(5)],
      primary: { kind: 'ticket', remainingHours: 2 },
      campaign: { discountType: 'percent', discountValue: 10 },
    });
    const overflow = 3 * 4840; // 14520
    expect(r.campaignDiscount).toBe(Math.round(overflow * 0.1)); // 1452
    expect(r.total).toBe(5 * 4840 - 2 * 4840 - 1452); // 14520 - 1452 = 13068
  });

  it('⑤高い時間帯（土日祝）から先に充当', () => {
    // 平日3h(4840) + 土日祝3h(7260) 混在、チケット残3h
    const r = applyDiscounts({
      days: [weekdayDay(3), weekendDay(3)],
      primary: { kind: 'ticket', remainingHours: 3 },
    });
    // 土日祝3h(高い)から充当 → 3*7260=21780 が¥0
    expect(r.primaryDiscount).toBe(3 * 7260); // 21780
    expect(r.ticketHoursConsumed).toBe(3);
  });
});

describe('applyDiscounts - ポイント', () => {
  it('④ポイントはスペース料金のみに使用、オプションには使えない', () => {
    const r = applyDiscounts({
      days: [weekdayDay(3)], // 14520
      primary: { kind: 'points', pointsToUse: 100000, pointBalance: 5000 },
      optionsTotal: 2000,
    });
    // 残高5000まで、かつスペース料金上限
    expect(r.pointsUsed).toBe(5000);
    expect(r.total).toBe(14520 - 5000 + 2000); // 11520
  });

  it('③ポイント使用時はキャンペーン対象外', () => {
    const r = applyDiscounts({
      days: [weekdayDay(3)],
      primary: { kind: 'points', pointsToUse: 1000, pointBalance: 5000 },
      campaign: { discountType: 'percent', discountValue: 10 },
    });
    expect(r.campaignDiscount).toBe(0);
    expect(r.total).toBe(14520 - 1000); // 13520
  });

  it('ポイントはスペース料金を超えて使えない', () => {
    const r = applyDiscounts({
      days: [weekdayDay(1)], // 4840
      primary: { kind: 'points', pointsToUse: 10000, pointBalance: 10000 },
    });
    expect(r.pointsUsed).toBe(4840);
    expect(r.total).toBe(0);
  });
});

describe('applyDiscounts - キャンペーン(割引なし時フル適用)', () => {
  it('割引なし + キャンペーン10% → スペース料金にフル適用', () => {
    const r = applyDiscounts({
      days: [weekdayDay(5)],
      primary: { kind: 'none' },
      campaign: { discountType: 'percent', discountValue: 10 },
    });
    expect(r.campaignDiscount).toBe(Math.round(5 * 4840 * 0.1)); // 2420
    expect(r.total).toBe(5 * 4840 - 2420); // 21780
  });
});

describe('resolveCampaign - 適用判定', () => {
  const cp = (over: Partial<CampaignCandidate>): CampaignCandidate => ({
    name: 'テスト', startDate: '2026-09-01', endDate: '2026-09-30',
    discountType: 'percent', discountValue: 10, applyWeekday: true, applyWeekend: true,
    spaceId: null, ...over,
  });

  it('期間内・全スペース対象なら適用（10%）', () => {
    const r = resolveCampaign([cp({})], [{ date: '2026-09-10', dayType: 'weekday', price: 10000 }], 'space-a');
    expect(r?.rule.discountValue).toBe(10);
    expect(r?.name).toBe('テスト');
  });

  it('期間外は不適用', () => {
    const r = resolveCampaign([cp({})], [{ date: '2026-10-01', dayType: 'weekday', price: 10000 }], 'space-a');
    expect(r).toBeNull();
  });

  it('対象スペースが異なれば不適用', () => {
    const r = resolveCampaign([cp({ spaceId: 'space-b' })], [{ date: '2026-09-10', dayType: 'weekday', price: 10000 }], 'space-a');
    expect(r).toBeNull();
  });

  it('平日限定キャンペーンは土日祝に不適用', () => {
    const r = resolveCampaign([cp({ applyWeekend: false })], [{ date: '2026-09-12', dayType: 'weekend', price: 10000 }], 'space-a');
    expect(r).toBeNull();
  });

  it('複数日で一部でも対象外があれば不適用', () => {
    const days = [
      { date: '2026-09-10', dayType: 'weekday' as const, price: 10000 },
      { date: '2026-10-10', dayType: 'weekday' as const, price: 10000 },
    ];
    expect(resolveCampaign([cp({})], days, 'space-a')).toBeNull();
  });

  it('複数該当時は割引額が大きい方を選ぶ', () => {
    const small = cp({ name: '小', discountValue: 10 });
    const big = cp({ name: '大', discountValue: 30 });
    const r = resolveCampaign([small, big], [{ date: '2026-09-10', dayType: 'weekday', price: 10000 }], 'space-a');
    expect(r?.name).toBe('大');
  });

  it('スペース指定ありは全スペース指定より具体的だが、選択は割引額で決まる', () => {
    // 同率なら最初に見つかった方（安定挙動の確認）
    const r = resolveCampaign(
      [cp({ name: 'A', discountValue: 20 }), cp({ name: 'B', discountValue: 20, spaceId: 'space-a' })],
      [{ date: '2026-09-10', dayType: 'weekday', price: 10000 }],
      'space-a',
    );
    expect(r?.name).toBe('A');
  });
});
