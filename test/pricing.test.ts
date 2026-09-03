import { describe, it, expect } from 'vitest';
import {
  computeDayPrice,
  computeGroupSpacePrice,
  detectConsecutiveGroups,
  findSeasonalPct,
  isExclusiveDay,
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

describe('computeDayPrice - 季節料金の1日料金（実額・#119）', () => {
  const hallWeekendDayOnly: SpacePricingConfig = { ...hall, weekendDayRateOnly: true };

  it('実額指定＋1日料金の日は rate×時間・割増率を上書きして固定額で課金', () => {
    // GW谷間の平日を土日祝相当（141,570円）で1日貸切にしたいケース
    const seasonalRules = [
      { name: 'GW谷間', startDate: '2026-05-01', endDate: '2026-05-02', surchargePct: 0, dayRateOnly: true, dayRateAmount: 141570 },
    ];
    const r = computeDayPrice(
      hall,
      { date: '2026-05-01', startTime: '10:00', endTime: '14:00' }, // Fri（平日）4時間
      { seasonalRules },
    );
    expect(r.billingMode).toBe('day');
    expect(r.price).toBe(141570); // 平日単価94,380ではなく実額
    expect(r.basePrice).toBe(141570);
    expect(r.seasonalPct).toBe(0);
    expect(r.seasonalSurcharge).toBe(0);
    expect(r.dayRateReason).toBe('period');
  });

  it('実額指定は割増率(%)を無視する（併記されていても実額が優先）', () => {
    const seasonalRules = [
      { name: '特別料金', startDate: '2026-05-01', endDate: '2026-05-02', surchargePct: 50, dayRateOnly: true, dayRateAmount: 141570 },
    ];
    const r = computeDayPrice(
      hall,
      { date: '2026-05-01', startTime: '10:00', endTime: '18:00' },
      { seasonalRules },
    );
    expect(r.price).toBe(141570); // 94,380×1.5=141,570 だが「実額」を採用（割増計算は行わない）
    expect(r.seasonalSurcharge).toBe(0);
  });

  it('実額指定は土日祝1日料金の日にも適用される（対象全スペース想定）', () => {
    const seasonalRules = [
      { name: '年末特別', startDate: '2026-05-01', endDate: '2026-05-31', surchargePct: 0, dayRateAmount: 200000 },
    ];
    const r = computeDayPrice(
      hallWeekendDayOnly,
      { date: '2026-05-02', startTime: '12:00', endTime: '17:00' }, // Sat（期間内）→土日祝1日料金
      { seasonalRules },
    );
    expect(r.billingMode).toBe('day');
    expect(r.price).toBe(200000); // 通常141,570を実額で上書き
    expect(r.dayRateReason).toBe('weekend');
  });

  it('実額指定でも時間料金（hourly）の日には適用しない（1日料金の日だけ）', () => {
    // hall は weekendDayRateOnly=false。平日・部分利用は時間料金のまま → 実額は無視、割増%のみ効く
    const seasonalRules = [
      { name: '実額のみ', startDate: '2026-04-20', endDate: '2026-04-24', surchargePct: 10, dayRateAmount: 141570 },
    ];
    const r = computeDayPrice(
      hall,
      { date: '2026-04-20', startTime: '10:00', endTime: '14:00' }, // Mon 4時間（時間料金）
      { seasonalRules },
    );
    expect(r.billingMode).toBe('hourly');
    expect(r.price).toBe(Math.round(4 * 7260 * 1.1)); // 実額は使わず、通常の割増%計算
  });

  it('実額0や未指定は従来通り rate×時間＋割増率で算出', () => {
    const seasonalRules = [
      { name: 'GW', startDate: '2026-04-29', endDate: '2026-05-06', surchargePct: 20, dayRateOnly: true, dayRateAmount: null },
    ];
    const r = computeDayPrice(
      hall,
      { date: '2026-05-01', startTime: '10:00', endTime: '14:00' },
      { seasonalRules },
    );
    expect(r.price).toBe(94380 + Math.round(94380 * 0.2)); // 従来計算
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

describe('isExclusiveDay - 終日1組専有日の判定（#101）', () => {
  const hallWeekendDayOnly: SpacePricingConfig = { ...hall, weekendDayRateOnly: true };

  it('block課金スペースは常に専有（曜日を問わず）', () => {
    expect(isExclusiveDay({ billingType: 'block', weekendDayRateOnly: false }, WEEKDAY)).toBe(true);
    expect(isExclusiveDay({ billingType: 'block', weekendDayRateOnly: false }, SATURDAY)).toBe(true);
  });

  it('土日祝1日料金のみ設定のスペースは土日祝のみ専有', () => {
    expect(isExclusiveDay(hallWeekendDayOnly, SATURDAY)).toBe(true);
    expect(isExclusiveDay(hallWeekendDayOnly, WEEKDAY)).toBe(false);
  });

  it('祝日(holiday)も土日祝扱いで専有', () => {
    const holidays = new Map<string, HolidayType>([[WEEKDAY, 'holiday']]);
    expect(isExclusiveDay(hallWeekendDayOnly, WEEKDAY, { holidays })).toBe(true);
  });

  it('季節料金「1日料金のみ」期間は平日でも専有', () => {
    const seasonalRules = [
      { name: 'GW', startDate: '2026-05-01', endDate: '2026-05-06', surchargePct: 0, dayRateOnly: true },
    ];
    expect(isExclusiveDay(hall, '2026-05-01', { seasonalRules })).toBe(true);
  });

  it('通常の割増のみ（dayRateOnly=false）の季節料金は専有にしない', () => {
    const seasonalRules = [
      { name: '繁忙', startDate: '2026-05-01', endDate: '2026-05-06', surchargePct: 30 },
    ];
    expect(isExclusiveDay(hall, '2026-05-01', { seasonalRules })).toBe(false);
  });

  it('実額指定だけ（dayRateOnly無し）では専有にしない', () => {
    const seasonalRules = [
      { name: '実額', startDate: '2026-05-01', endDate: '2026-05-06', surchargePct: 0, dayRateAmount: 141570 },
    ];
    expect(isExclusiveDay(hall, '2026-05-01', { seasonalRules })).toBe(false);
  });

  it('通常の時間貸しスペースの平日は専有しない', () => {
    expect(isExclusiveDay(hall, WEEKDAY)).toBe(false);
  });
});
