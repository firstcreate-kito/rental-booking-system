import { describe, it, expect } from 'vitest';
import {
  computeDayPrice,
  computeGroupSpacePrice,
  detectConsecutiveGroups,
  findSeasonalPct,
  PricingError,
  type SpacePricingConfig,
} from '../src/lib/pricing';
import type { HolidayType } from '../src/lib/calendar';

// 実料金表(2026-08-12版)に基づくスペース設定
const hall: SpacePricingConfig = {
  billingType: 'hourly',
  weekdayRate: 7260,
  weekendRate: 10890,
  dayRateHours: 13,
  weekdayAvailable: true,
  weekendAvailable: true,
  openTime: '08:00',
  closeTime: '22:00',
  hasMinimum: true,
  minHours: 3,
};

const free: SpacePricingConfig = {
  billingType: 'hourly',
  weekdayRate: 4840,
  weekendRate: 7260,
  dayRateHours: 13,
  weekdayAvailable: true,
  weekendAvailable: true,
  openTime: '08:00',
  closeTime: '22:00',
  hasMinimum: true,
  minHours: 1,
};

const exercise: SpacePricingConfig = {
  billingType: 'hourly',
  weekdayRate: 2200,
  weekendRate: 2200,
  dayRateHours: null, // 1日料金なし
  weekdayAvailable: true,
  weekendAvailable: true,
  openTime: '08:00',
  closeTime: '22:00',
  hasMinimum: true,
  minHours: 1,
};

const warehouse: SpacePricingConfig = {
  billingType: 'hourly',
  weekdayRate: null, // 平日は貸出なし
  weekendRate: 5500,
  dayRateHours: null, // 1日料金なし
  weekdayAvailable: false,
  weekendAvailable: true,
  openTime: '10:00',
  closeTime: '17:00',
  hasMinimum: true,
  minHours: 3,
};

const WEEKDAY = '2026-04-20'; // Mon
const WEEKDAY2 = '2026-04-21'; // Tue
const SATURDAY = '2026-04-25'; // Sat

describe('computeDayPrice - 時間料金', () => {
  it('平日の部分利用（6時間）', () => {
    const r = computeDayPrice(hall, { date: WEEKDAY, startTime: '10:00', endTime: '16:00' });
    expect(r.billingMode).toBe('hourly');
    expect(r.dayType).toBe('weekday');
    expect(r.billableHours).toBe(6);
    expect(r.price).toBe(6 * 7260); // 43560
  });

  it('30分は1時間に切り上げ（2.5h → 3h）', () => {
    const r = computeDayPrice(free, { date: WEEKDAY, startTime: '10:00', endTime: '12:30' });
    expect(r.billableHours).toBe(3);
    expect(r.price).toBe(3 * 4840); // 14520
  });

  it('最低利用時間を下回ると min_hours で計算（1h → 3h）', () => {
    const r = computeDayPrice(hall, { date: WEEKDAY, startTime: '10:00', endTime: '11:00' });
    expect(r.billableHours).toBe(3);
    expect(r.price).toBe(3 * 7260); // 21780
  });
});

describe('computeDayPrice - 1日料金', () => {
  it('平日に営業時間ちょうど全部 → 1日料金(13h)', () => {
    const r = computeDayPrice(hall, { date: WEEKDAY, startTime: '08:00', endTime: '22:00' });
    expect(r.billingMode).toBe('day');
    expect(r.billableHours).toBe(13);
    expect(r.price).toBe(94380); // 料金表の1日(平日)と一致
  });

  it('土日祝に営業時間ちょうど全部 → 1日料金(土日祝単価)', () => {
    const r = computeDayPrice(hall, { date: SATURDAY, startTime: '08:00', endTime: '22:00' });
    expect(r.billingMode).toBe('day');
    expect(r.price).toBe(141570); // 料金表の1日(土日祝)と一致
  });

  it('1日料金なしのスペースは全営業時間でも時間料金のまま', () => {
    const r = computeDayPrice(exercise, { date: WEEKDAY, startTime: '08:00', endTime: '22:00' });
    expect(r.billingMode).toBe('hourly');
    expect(r.billableHours).toBe(14);
    expect(r.price).toBe(14 * 2200); // 30800
  });

  it('残置日は1日料金（実利用時間に関わらず）', () => {
    const r = computeDayPrice(hall, {
      date: WEEKDAY,
      startTime: '10:00',
      endTime: '18:00',
      isResidence: true,
    });
    expect(r.billingMode).toBe('day');
    expect(r.isResidence).toBe(true);
    expect(r.price).toBe(94380);
  });
});

describe('computeDayPrice - 曜日区分/祝日', () => {
  it('祝日(holiday)は平日でも土日祝料金', () => {
    const holidays = new Map<string, HolidayType>([[WEEKDAY, 'holiday']]);
    const r = computeDayPrice(
      hall,
      { date: WEEKDAY, startTime: '10:00', endTime: '16:00' },
      { holidays },
    );
    expect(r.dayType).toBe('weekend');
    expect(r.price).toBe(6 * 10890); // 65340
  });
});

describe('computeDayPrice - 季節料金', () => {
  it('季節料金 +30% を加算', () => {
    const seasonalRules = [{ startDate: '2026-04-18', endDate: '2026-04-22', surchargePct: 30 }];
    const r = computeDayPrice(
      hall,
      { date: WEEKDAY, startTime: '10:00', endTime: '16:00' },
      { seasonalRules },
    );
    expect(r.basePrice).toBe(43560);
    expect(r.seasonalPct).toBe(30);
    expect(r.seasonalSurcharge).toBe(13068);
    expect(r.price).toBe(56628);
  });

  it('findSeasonalPct: 期間外は0', () => {
    const rules = [{ startDate: '2026-04-18', endDate: '2026-04-22', surchargePct: 30 }];
    expect(findSeasonalPct('2026-04-25', rules)).toBe(0);
    expect(findSeasonalPct('2026-04-20', rules)).toBe(30);
  });
});

describe('computeDayPrice - 1日料金のみ課金（#18）', () => {
  // アルベホール名古屋を想定: 土日祝は1日料金のみ
  const hallWeekendDayOnly: SpacePricingConfig = { ...hall, weekendDayRateOnly: true };

  it('土日祝は入退時刻に関わらず1日料金（部分利用でも日料金）', () => {
    const r = computeDayPrice(hallWeekendDayOnly, {
      date: SATURDAY,
      startTime: '12:00',
      endTime: '17:00', // 5時間だが1日料金
    });
    expect(r.dayType).toBe('weekend');
    expect(r.billingMode).toBe('day');
    expect(r.billableHours).toBe(13);
    expect(r.price).toBe(13 * 10890); // 141570
    expect(r.dayRateReason).toBe('weekend');
  });

  it('祝日(holiday)も土日祝扱いで1日料金', () => {
    const holidays = new Map<string, HolidayType>([[WEEKDAY, 'holiday']]);
    const r = computeDayPrice(
      hallWeekendDayOnly,
      { date: WEEKDAY, startTime: '10:00', endTime: '13:00' },
      { holidays },
    );
    expect(r.dayType).toBe('weekend');
    expect(r.billingMode).toBe('day');
    expect(r.price).toBe(13 * 10890);
  });

  it('平日は従来通り時間料金（土日祝フラグの影響を受けない）', () => {
    const r = computeDayPrice(hallWeekendDayOnly, {
      date: WEEKDAY,
      startTime: '10:00',
      endTime: '16:00',
    });
    expect(r.billingMode).toBe('hourly');
    expect(r.price).toBe(6 * 7260);
  });

  it('土日入り〜日曜出の複数日は各日とも1日料金', () => {
    const g = computeGroupSpacePrice(hallWeekendDayOnly, [
      { date: SATURDAY, startTime: '12:00', endTime: '22:00' },
      { date: '2026-04-26', startTime: '08:00', endTime: '17:00' }, // Sun
    ]);
    expect(g.days[0].billingMode).toBe('day');
    expect(g.days[1].billingMode).toBe('day');
    expect(g.spaceTotal).toBe(13 * 10890 * 2); // 283140
  });

  it('期間指定「1日料金のみ」は平日でも1日料金（GW・谷間）', () => {
    // hall は weekendDayRateOnly=false のまま。期間フラグだけで平日を1日料金に。
    const seasonalRules = [
      { name: 'GW', startDate: '2026-04-29', endDate: '2026-05-06', surchargePct: 0, dayRateOnly: true },
    ];
    const GW_WEEKDAY = '2026-05-01'; // Fri（平日）
    const r = computeDayPrice(
      hall,
      { date: GW_WEEKDAY, startTime: '10:00', endTime: '14:00' }, // 4時間だが1日料金
      { seasonalRules },
    );
    expect(r.dayType).toBe('weekday');
    expect(r.billingMode).toBe('day');
    expect(r.rate).toBe(7260); // 平日単価で日料金
    expect(r.price).toBe(13 * 7260); // 94380
    expect(r.dayRateReason).toBe('period');
    expect(r.dayRateName).toBe('GW');
  });

  it('期間指定「1日料金のみ」＋割増% は併用できる', () => {
    const seasonalRules = [
      { name: 'GW繁忙', startDate: '2026-04-29', endDate: '2026-05-06', surchargePct: 20, dayRateOnly: true },
    ];
    const r = computeDayPrice(
      hall,
      { date: '2026-05-01', startTime: '10:00', endTime: '14:00' },
      { seasonalRules },
    );
    expect(r.billingMode).toBe('day');
    expect(r.basePrice).toBe(13 * 7260); // 94380
    expect(r.seasonalPct).toBe(20);
    expect(r.seasonalSurcharge).toBe(Math.round(94380 * 0.2)); // 18876
    expect(r.price).toBe(94380 + 18876); // 113256
  });

  it('1日料金のみ指定でも day_rate_hours 未設定ならエラー', () => {
    const noDayRate: SpacePricingConfig = { ...hall, dayRateHours: null, weekendDayRateOnly: true };
    expect(() =>
      computeDayPrice(noDayRate, { date: SATURDAY, startTime: '12:00', endTime: '17:00' }),
    ).toThrowError(PricingError);
  });
});

describe('computeDayPrice - 提供可否', () => {
  it('倉庫は平日不可 → DAY_UNAVAILABLE', () => {
    expect(() =>
      computeDayPrice(warehouse, { date: WEEKDAY, startTime: '10:00', endTime: '14:00' }),
    ).toThrowError(PricingError);
  });

  it('倉庫は土日祝の時間料金（4h, min3クリア）', () => {
    const r = computeDayPrice(warehouse, { date: SATURDAY, startTime: '10:00', endTime: '14:00' });
    expect(r.billingMode).toBe('hourly');
    expect(r.price).toBe(4 * 5500); // 22000
  });
});

describe('computeGroupSpacePrice - 連日+残置', () => {
  it('初日残置(1日料金)+翌日時間料金', () => {
    const r = computeGroupSpacePrice(hall, [
      { date: WEEKDAY, startTime: '10:00', endTime: '18:00', isResidence: true },
      { date: WEEKDAY2, startTime: '10:00', endTime: '18:00' },
    ]);
    expect(r.days[0].price).toBe(94380); // 残置=1日料金
    expect(r.days[1].price).toBe(8 * 7260); // 58080
    expect(r.spaceTotal).toBe(94380 + 58080); // 152460
    expect(r.totalBillableHours).toBe(13 + 8);
  });
});

describe('detectConsecutiveGroups', () => {
  it('連続日をグループ化し、単発日は別グループ', () => {
    const groups = detectConsecutiveGroups(['2026-04-20', '2026-04-21', '2026-04-23']);
    expect(groups).toEqual([['2026-04-20', '2026-04-21'], ['2026-04-23']]);
  });

  it('順不同・重複を正規化', () => {
    const groups = detectConsecutiveGroups(['2026-04-23', '2026-04-20', '2026-04-20', '2026-04-21']);
    expect(groups).toEqual([['2026-04-20', '2026-04-21'], ['2026-04-23']]);
  });
});
