/**
 * 料金計算エンジン（スペース利用料金）
 *
 * 仕様 v2.1 の確定事項に基づく:
 *  - 料金は「1時間単価（平日 / 土日祝）」に一本化（時間帯別料金は廃止）
 *  - 1日料金は day_rate_hours（全スペース共通で13）で表現し、
 *      日料金 = day_rate_hours × 適用1時間単価
 *  - 発動条件:
 *      billing_type='block' → 常に1日料金
 *      billing_type='hourly' → 営業時間ちょうど全部を選択、または残置日 のとき1日料金
 *  - 最低利用時間は時間料金モードにのみ適用
 *  - 季節料金は該当日の金額に surcharge_pct% を加算（1日料金/残置日にも適用）
 *
 * ※ 割引クーポン・チケット・ポイント・キャンペーン・オプションは別レイヤーで扱う。
 */
import { ceilHours, diffHours } from './time';
import { getDayType, type DayType, type HolidayType } from './calendar';

export type BillingType = 'hourly' | 'block';
export type BillingMode = 'hourly' | 'day';

/** スペースの料金設定（DBの spaces から必要分を抽出） */
export interface SpacePricingConfig {
  billingType: BillingType;
  weekdayRate: number | null; // 平日1時間単価（NULL=平日は時間貸ししない）
  weekendRate: number | null; // 土日祝1時間単価
  dayRateHours: number | null; // 1日料金の課金時間数（NULL=1日料金なし）
  weekdayAvailable: boolean;
  weekendAvailable: boolean;
  openTime: string; // 'HH:MM'
  closeTime: string; // 'HH:MM'
  hasMinimum: boolean;
  minHours: number;
}

/** 1日分の予約入力 */
export interface DayBookingInput {
  date: string; // 'YYYY-MM-DD'
  startTime: string; // 'HH:MM'
  endTime: string; // 'HH:MM'
  /** 翌日へ荷物を残す日（1日料金を適用） */
  isResidence?: boolean;
}

/** 季節料金ルール */
export interface SeasonalRule {
  name?: string; // 表示用の名称（例：アジア競技大会料金）
  startDate: string; // 'YYYY-MM-DD'
  endDate: string; // 'YYYY-MM-DD'
  surchargePct: number; // 30 = +30%
}

/** 計算の外部データ */
export interface PricingContext {
  holidays?: ReadonlyMap<string, HolidayType>;
  seasonalRules?: readonly SeasonalRule[];
}

/** 1日分の料金計算結果 */
export interface DayPriceResult {
  date: string;
  dayType: DayType;
  billingMode: BillingMode;
  rate: number; // 適用した1時間単価
  billableHours: number; // 課金時間数
  isResidence: boolean;
  basePrice: number; // 季節料金加算前
  seasonalPct: number; // 適用された季節割増率（0なら非該当）
  seasonalName: string | null; // 適用された季節料金の名称（非該当なら null）
  seasonalSurcharge: number; // 季節料金加算額
  price: number; // この日の最終スペース料金
}

export class PricingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PricingError';
    this.code = code;
  }
}

/** 'YYYY-MM-DD' が季節料金期間に該当するか（最初に一致したルールを採用） */
export function findSeasonalPct(dateISO: string, rules?: readonly SeasonalRule[]): number {
  return findSeasonalMatch(dateISO, rules)?.surchargePct ?? 0;
}

/** 'YYYY-MM-DD' に該当する季節料金ルール（名称込み）を返す。非該当なら null */
export function findSeasonalMatch(
  dateISO: string,
  rules?: readonly SeasonalRule[],
): { surchargePct: number; name: string | null } | null {
  if (!rules) return null;
  for (const r of rules) {
    if (dateISO >= r.startDate && dateISO <= r.endDate) {
      return { surchargePct: r.surchargePct, name: r.name ?? null };
    }
  }
  return null;
}

/**
 * 1日分のスペース利用料金を計算する。
 * （休業日・受付期間などの予約可否チェックは呼び出し側で実施する前提）
 */
export function computeDayPrice(
  space: SpacePricingConfig,
  booking: DayBookingInput,
  ctx: PricingContext = {},
): DayPriceResult {
  const dayType = getDayType(booking.date, ctx.holidays);

  // 曜日区分ごとの提供可否
  const available = dayType === 'weekend' ? space.weekendAvailable : space.weekdayAvailable;
  if (!available) {
    throw new PricingError('DAY_UNAVAILABLE', `${booking.date} はこのスペースの予約対象外です`);
  }

  const rate = dayType === 'weekend' ? space.weekendRate : space.weekdayRate;
  if (rate == null) {
    throw new PricingError('RATE_UNAVAILABLE', `${booking.date} の単価が設定されていません`);
  }

  const isResidence = booking.isResidence ?? false;
  const actualHours = ceilHours(diffHours(booking.startTime, booking.endTime));
  if (actualHours <= 0) {
    throw new PricingError('INVALID_RANGE', '利用時間が0以下です');
  }

  const isFullSpan = booking.startTime === space.openTime && booking.endTime === space.closeTime;

  let billingMode: BillingMode;
  let billableHours: number;

  if (space.billingType === 'block') {
    // 1日単位専用スペース: 常に1日料金
    if (space.dayRateHours == null) {
      throw new PricingError('BLOCK_NO_DAY_RATE', 'block課金だが1日料金が未設定です');
    }
    billingMode = 'day';
    billableHours = space.dayRateHours;
  } else if (isResidence && space.dayRateHours != null) {
    // 残置日: 1日料金
    billingMode = 'day';
    billableHours = space.dayRateHours;
  } else if (isFullSpan && space.dayRateHours != null) {
    // 営業時間ちょうど全部: 1日料金へ差し替え
    billingMode = 'day';
    billableHours = space.dayRateHours;
  } else {
    // 通常の時間料金
    billingMode = 'hourly';
    billableHours = actualHours;
    // 最低利用時間（時間料金モードのみ）
    if (space.hasMinimum && billableHours < space.minHours) {
      billableHours = space.minHours;
    }
  }

  const basePrice = billableHours * rate;

  // 季節料金（該当日の金額に加算）
  const seasonalMatch = findSeasonalMatch(booking.date, ctx.seasonalRules);
  const seasonalPct = seasonalMatch?.surchargePct ?? 0;
  const seasonalName = seasonalPct > 0 ? seasonalMatch?.name ?? null : null;
  const seasonalSurcharge = seasonalPct > 0 ? Math.round((basePrice * seasonalPct) / 100) : 0;
  const price = basePrice + seasonalSurcharge;

  return {
    date: booking.date,
    dayType,
    billingMode,
    rate,
    billableHours,
    isResidence,
    basePrice,
    seasonalPct,
    seasonalName,
    seasonalSurcharge,
    price,
  };
}

/** 予約グループ（複数日）のスペース料金合計 */
export interface GroupPriceResult {
  days: DayPriceResult[];
  spaceTotal: number; // スペース利用料金の合計（割引・オプション適用前）
  totalBillableHours: number; // 課金時間数の合計
}

export function computeGroupSpacePrice(
  space: SpacePricingConfig,
  bookings: readonly DayBookingInput[],
  ctx: PricingContext = {},
): GroupPriceResult {
  const days = bookings.map((b) => computeDayPrice(space, b, ctx));
  const spaceTotal = days.reduce((sum, d) => sum + d.price, 0);
  const totalBillableHours = days.reduce((sum, d) => sum + d.billableHours, 0);
  return { days, spaceTotal, totalBillableHours };
}

/**
 * カート内の日程から「連日グループ」を検出する（残置確認UI用）。
 * @returns 連続する日付の配列（各要素が1つの連日グループ）。単発日も1要素として返る。
 */
export function detectConsecutiveGroups(dates: readonly string[]): string[][] {
  const sorted = [...new Set(dates)].sort();
  const groups: string[][] = [];
  let current: string[] = [];
  for (const d of sorted) {
    if (current.length === 0) {
      current = [d];
      continue;
    }
    const prev = current[current.length - 1];
    if (isNextDay(prev, d)) {
      current.push(d);
    } else {
      groups.push(current);
      current = [d];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** a の翌日が b か（'YYYY-MM-DD'） */
function isNextDay(a: string, b: string): boolean {
  const [ay, am, ad] = a.split('-').map(Number);
  const next = new Date(Date.UTC(ay, am - 1, ad + 1, 12));
  const iso = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(
    next.getUTCDate(),
  ).padStart(2, '0')}`;
  return iso === b;
}
