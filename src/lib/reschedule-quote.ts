import {
  getHolidays,
  getActiveSeasonalRulesForSpace,
  getTicketUsageForGroup,
  type SpaceRow,
  type BookingGroupRow,
} from '../db/repository';
import { computeGroupSpacePrice, type SpacePricingConfig, type SeasonalRule, type DayBookingInput } from './pricing';
import { computeAdjustment, type AdjustmentResult } from './cancellation';
import { computeChangeSettlement, type ChangeSettlement } from './change-settlement';
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
  adjustment: AdjustmentResult; // 単純差額（参考値。実際の返金/請求は settlement を使う）
  settlement: ChangeSettlement; // 統一ポリシー §2 の精算額（承認時の実処理と同一ロジック）
  cancelChargePct: number; // 当初利用日基準のキャンセル料率（減額按分・キャンセル扱い判定に使用）
  ticket: boolean; // チケット（回数券）予約：日程移動では金額は変わらない
  paymentMethod: string | null; // 支払方法（'invoice'＝自社口座への直接振込のみ振込手数料を差引く旨を表示）
}

/**
 * 日時変更（reschedule）の精算見積を算出する。#100 / 統一ポリシー §2
 * 実際の日時変更処理（POST /api/mypage/bookings/:number/reschedule）と**同一のロジック**
 * （computeChangeSettlement＋当初利用日基準のキャンセル料率）で、お客様に「追加請求／返金／
 * キャンセル扱い」の金額を事前提示する（確定はしない）。表示額＝承認時の実精算額を一致させる。
 *
 * - 非チケット予約：
 *     増額 … 差額を追加請求。
 *     減額 … 減少分を「一部キャンセル」とみなし、キャンセル料率で按分して返金。
 *     キャンセル扱い（標準=当日／防音室=当日・前日）… 旧予約は返金なし・新予約は満額請求。
 * - チケット予約：日程移動では合計利用時間が変わらない前提のため現金精算なし（ticket=true）。
 *
 * @param cancelChargePct 当初利用日基準のキャンセル料率(0〜100)。呼び出し側で computeCancelCharge により算出して渡す。
 */
export async function quoteReschedule(
  db: D1Database,
  group: BookingGroupRow,
  space: SpaceRow,
  proposedItems: readonly RescheduleQuoteItem[],
  cancelChargePct: number,
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
    dayRateAmount: r.day_rate_amount ?? null,
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
      settlement: { kind: 'move', refund: 0, charge: 0, note: 'チケット（回数券）でのご予約のため、日時の移動による現金の精算はありません。' },
      cancelChargePct,
      ticket: true,
      paymentMethod: group.payment_method,
    };
  }

  const newTotal = newGroup.spaceTotal;
  // 精算は当初金額基準（original_total_amount）で行う。承認時の実処理（computeChangeSettlement）と一致させる。
  const originalTotal = group.original_total_amount ?? group.total_amount;
  return {
    currentTotal: group.total_amount,
    newTotal,
    adjustment: computeAdjustment(group.total_amount, newTotal),
    settlement: computeChangeSettlement(originalTotal, newTotal, cancelChargePct),
    cancelChargePct,
    ticket: false,
    paymentMethod: group.payment_method,
  };
}
