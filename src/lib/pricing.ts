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
  /**
   * 土日祝は時間料金を出さず常に1日料金にする（#18）。
   * true のとき、weekend 判定の日は入退時刻に関わらず1日料金（dayRateHours 必須）。
   * 既定 false（未指定）＝従来通り。
   */
  weekendDayRateOnly?: boolean;
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
  /**
   * この期間は平日でも1日料金のみにする（#18）。GW・その谷間など。
   * true のとき、期間内の日は入退時刻に関わらず1日料金（dayRateHours 必須）。
   * surchargePct と併用可（1日料金へ季節割増も加算される）。既定 false。
   */
  dayRateOnly?: boolean;
  /**
   * この期間の1日料金を「実額（円）」で固定する（#18拡張）。
   * 値があり、かつその日が1日料金（billingMode==='day'）になる場合、単価×時間や
   * 割増率%の計算を上書きしてこの額を1日料金として用いる。NULL/未指定なら従来計算。
   * 主に1スペース対象のルールで使う想定（対象スペースの選択は季節料金側で制御）。
   */
  dayRateAmount?: number | null;
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
  /**
   * 1日料金になった理由（billingMode==='day' のとき）。表示の出し分け用（#18）。
   *  'block'     … 1日単位専用スペース
   *  'weekend'   … 土日祝は1日料金のみ設定
   *  'period'    … 指定期間は1日料金のみ（GW・谷間など。名称は dayRateName）
   *  'residence' … 残置日
   *  'fullspan'  … 営業時間ちょうど全部
   *  null        … 時間料金（billingMode==='hourly'）
   */
  dayRateReason: 'block' | 'weekend' | 'period' | 'residence' | 'fullspan' | null;
  dayRateName: string | null; // reason==='period' のときの期間名称（例：シルバーウィークのため終日料金のみ）
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
): { surchargePct: number; name: string | null; dayRateOnly: boolean; dayRateAmount: number | null } | null {
  if (!rules) return null;
  for (const r of rules) {
    if (dateISO >= r.startDate && dateISO <= r.endDate) {
      return {
        surchargePct: r.surchargePct,
        name: r.name ?? null,
        dayRateOnly: r.dayRateOnly ?? false,
        dayRateAmount: r.dayRateAmount ?? null,
      };
    }
  }
  return null;
}

/**
 * その日が「終日1組専有（1日貸切）」になる日か判定する（#101 / #18 Phase2）。
 *
 * 1日料金が入退時刻に関わらず適用される日は、当該スペースをその日1組で専有する運用にする。
 * 発動条件（いずれか）:
 *   ① billing_type='block'（1日単位専用スペース）
 *   ② 土日祝 かつ weekendDayRateOnly（土日祝は1日料金のみ設定）
 *   ③ 季節料金の「1日料金のみ」期間（GW・谷間など。対象スペースの絞り込みは
 *      呼び出し側が seasonalRules をスペース別に渡すことで担保する）
 *
 * ※ 実額指定（dayRateAmount）だけでは専有にならない（1日料金のみ期間か否かで判断）。
 * ※ fullspan / residence は個別予約の都合であり「日単位の専有」ではないため対象外。
 */
export function isExclusiveDay(
  space: Pick<SpacePricingConfig, 'billingType' | 'weekendDayRateOnly'>,
  dateISO: string,
  ctx: PricingContext = {},
): boolean {
  if (space.billingType === 'block') return true;
  const dayType = getDayType(dateISO, ctx.holidays);
  if (dayType === 'weekend' && space.weekendDayRateOnly === true) return true;
  if (findSeasonalMatch(dateISO, ctx.seasonalRules)?.dayRateOnly === true) return true;
  return false;
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

  // 季節料金ルールの該当判定（金額加算 と 「1日料金のみ期間」判定で共用）
  const seasonalMatch = findSeasonalMatch(booking.date, ctx.seasonalRules);

  // #18「1日料金のみ」課金の発動条件
  //  ① 土日祝は1日料金のみ（スペース設定）
  //  ② この期間は1日料金のみ（季節料金の期間フラグ。GW・谷間など平日も対象）
  const weekendForcesDay = dayType === 'weekend' && space.weekendDayRateOnly === true;
  const periodForcesDay = seasonalMatch?.dayRateOnly === true;
  const dayRateOnly = weekendForcesDay || periodForcesDay;

  let billingMode: BillingMode;
  let billableHours: number;
  let dayRateReason: DayPriceResult['dayRateReason'] = null;
  let dayRateName: string | null = null;

  if (space.billingType === 'block') {
    // 1日単位専用スペース: 常に1日料金
    if (space.dayRateHours == null) {
      throw new PricingError('BLOCK_NO_DAY_RATE', 'block課金だが1日料金が未設定です');
    }
    billingMode = 'day';
    billableHours = space.dayRateHours;
    dayRateReason = 'block';
  } else if (dayRateOnly) {
    // #18: 土日祝 or 指定期間は入退時刻に関わらず1日料金
    if (space.dayRateHours == null) {
      throw new PricingError('DAY_RATE_ONLY_NO_DAY_RATE', '1日料金のみ設定だが1日料金（day_rate_hours）が未設定です');
    }
    billingMode = 'day';
    billableHours = space.dayRateHours;
    // 期間指定（名称あり）を優先して理由表示に使う。無ければ土日祝設定。
    if (periodForcesDay) {
      dayRateReason = 'period';
      dayRateName = seasonalMatch?.name ?? null;
    } else {
      dayRateReason = 'weekend';
    }
  } else if (isResidence && space.dayRateHours != null) {
    // 残置日: 1日料金
    billingMode = 'day';
    billableHours = space.dayRateHours;
    dayRateReason = 'residence';
  } else if (isFullSpan && space.dayRateHours != null) {
    // 営業時間ちょうど全部: 1日料金へ差し替え
    billingMode = 'day';
    billableHours = space.dayRateHours;
    dayRateReason = 'fullspan';
  } else {
    // 通常の時間料金
    billingMode = 'hourly';
    billableHours = actualHours;
    // 最低利用時間（時間料金モードのみ）
    if (space.hasMinimum && billableHours < space.minHours) {
      billableHours = space.minHours;
    }
  }

  // 季節料金の「1日料金（実額）」：この期間に固定額が設定されていて、かつこの日が
  // 1日料金（day）になる場合は、単価×時間・割増率%を上書きしてその実額を採用する（#18拡張）。
  const seasonalDayAmount = seasonalMatch?.dayRateAmount ?? null;
  const useFixedDayAmount = billingMode === 'day' && seasonalDayAmount != null && seasonalDayAmount > 0;

  let basePrice: number;
  let seasonalPct: number;
  let seasonalName: string | null;
  let seasonalSurcharge: number;
  let price: number;
  if (useFixedDayAmount) {
    basePrice = seasonalDayAmount as number;
    seasonalPct = 0;
    seasonalName = null; // 割増率は使わないため表示なし（理由は dayRateReason/dayRateName で表現）
    seasonalSurcharge = 0;
    price = seasonalDayAmount as number;
  } else {
    basePrice = billableHours * rate;
    // 季節料金（該当日の金額に加算）※ seasonalMatch は上部で算出済み
    seasonalPct = seasonalMatch?.surchargePct ?? 0;
    seasonalName = seasonalPct > 0 ? seasonalMatch?.name ?? null : null;
    seasonalSurcharge = seasonalPct > 0 ? Math.round((basePrice * seasonalPct) / 100) : 0;
    price = basePrice + seasonalSurcharge;
  }

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
    dayRateReason,
    dayRateName,
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
