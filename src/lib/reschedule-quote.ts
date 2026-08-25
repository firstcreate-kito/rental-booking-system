import {
  getHolidays,
  getActiveSeasonalRulesForSpace,
  getTicketUsageForGroup,
  type SpaceRow,
  type BookingGroupRow,
} from '../db/repository';
import { computeGroupSpacePrice, type SpacePricingConfig, type SeasonalRule, type DayBookingInput } from './pricing';
import { computeAdjustment, type AdjustmentResult } from './cancellation';
import { type HolidayType } from './calendar';

/** SpaceRow → 料金計算用の設定（bookings.ts / admin.ts と同じ写像） */
function toPricingConfig(s: SpaceRow): SpacePricingConfig {
  return {
    billingType: s.billing_type,
    weekdayRate: s.weekday_rate,
    weekendRate: s.weekend_rate,
    dayRateHours: s.day_rate_hours,
    weekdayAvailable: !!s.weekday_available,
    weekendAvailable: !!s.weekend_available,
    openTime: s.open_time,
    closeTime: s.close_time,
    hasMinimum: !!s.has_minimum,
    minHours: s.min_hours,
    weekendDayRateOnly: !!s.weekend_day_rate_only,
  };
}

export interface RescheduleQuoteItem {
  date: string;
  startTime: string;
  endTime: string;
  isResidence?: boolean;
}

export interface RescheduleQuote {
  currentTotal: number; // 変更前の予約金額（グループ合計）
  newTotal: number; // 希望日時での新しいスペース料金
  adjustment: AdjustmentResult; // 差額（surcharge=追加請求 / refund=返金 / zero=変わらず）
  ticket: boolean; // チケット（回数券）予約：日程移動では金額は変わらない
  paymentMethod: string | null; // 支払方法（'invoice'＝自社口座への直接振込のみ振込手数料を差引く旨を表示）
}

/**
 * 日時変更（reschedule）の差額見積を算出する。#100
 * 実際の日時変更処理（POST /api/bookings/:number/reschedule）と同じ料金計算を用い、
 * お客様に「追加請求／返金」の金額を事前提示するために使う（確定はしない）。
 *
 * - 非チケット予約：新しいスペース料金 vs 変更前の合計金額の差。
 * - チケット予約：日程移動では合計利用時間が変わらない前提のため差額なし（ticket=true）。
 */
export async function quoteReschedule(
  db: D1Database,
  group: BookingGroupRow,
  space: SpaceRow,
  proposedItems: readonly RescheduleQuoteItem[],
): Promise<RescheduleQuote> {
  const itemDates = proposedItems.map((i) => i.date).sort();
  const [holidays, seasonalRows] = await Promise.all([
    getHolidays(db, itemDates[0], itemDates[itemDates.length - 1]),
    getActiveSeasonalRulesForSpace(db, space.id),
  ]);
  const holidayMap = holidays as ReadonlyMap<string, HolidayType>;
  const seasonalRules: SeasonalRule[] = seasonalRows.map((r) => ({
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    surchargePct: r.surcharge_pct,
    dayRateOnly: !!r.day_rate_only,
  }));
  const dayInputs: DayBookingInput[] = proposedItems.map((i) => ({
    date: i.date,
    startTime: i.startTime,
    endTime: i.endTime,
    isResidence: i.isResidence,
  }));
  const newGroup = computeGroupSpacePrice(toPricingConfig(space), dayInputs, {
    holidays: holidayMap,
    seasonalRules,
  });

  // チケット予約は「合計利用時間」を変えられない＝日程移動では金額が変わらない（#24 の方針に一致）
  const ticketUsage = await getTicketUsageForGroup(db, group.id);
  if (ticketUsage) {
    return {
      currentTotal: group.total_amount,
      newTotal: group.total_amount,
      adjustment: { type: 'zero', amount: 0 },
      ticket: true,
      paymentMethod: group.payment_method,
    };
  }

  const newTotal = newGroup.spaceTotal;
  return {
    currentTotal: group.total_amount,
    newTotal,
    adjustment: computeAdjustment(group.total_amount, newTotal),
    ticket: false,
    paymentMethod: group.payment_method,
  };
}
