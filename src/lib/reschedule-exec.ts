/**
 * 日時変更の「枠移動」実行（Phase B・統一ポリシー §5）。
 * docs/unified-change-cancel-policy.md
 *
 * お客様の申込＝枠を即時に新枠へ移動する処理をここに集約する（会員マイページ用）。
 *  - 空き検証（営業時間・締切・競合・Googleカレンダー競合）
 *  - 旧 bookings を差し替え（削除→新規挿入）、total_amount / reschedule_count を更新
 *  - チケット払いは統一ポリシー §4（ticketChangePlan）に従い返還/失効/付替
 *  - Googleカレンダー同期（旧イベント削除→新規作成）
 *
 * 金額の精算（返金/追加請求）は本関数では行わない（管理者承認時に確定）。
 * 既存の POST /api/bookings/:number/reschedule（ゲスト/管理用）とは別に、
 * チケットの新ルール（partial_forfeit / blocked）を扱うため独立実装とする。
 */
import type { Env } from '../types';
import {
  getHolidays,
  getSpaceClosures,
  getActiveSeasonalRulesForSpace,
  getOccupyingIntervalsExcludingGroup,
  getSystemSettings,
  getBookingsByGroup,
  getTicketUsageForGroup,
  buildTicketRescheduleStmts,
  type SpaceRow,
  type BookingGroupRow,
} from '../db/repository';
import {
  computeGroupSpacePrice,
  isExclusiveDay,
  type SpacePricingConfig,
  type SeasonalRule,
  type DayBookingInput,
} from './pricing';
import { coveredAmountForHours } from './discounts';
import {
  validateBookingItem,
  intervalsOverlap,
  type BookingValidationSpace,
  type BookingItemInput,
} from './availability';
import { getDayType, isClosed, daysBetween, type HolidayType } from './calendar';
import { ticketChangePlan, type TicketChangeAction } from './ticket-policy';
import { checkCalendarConflictExcluding, syncBookingCalendarEvents, deleteBookingFromCalendar } from './gcal-sync';

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

function toValidationSpace(s: SpaceRow): BookingValidationSpace {
  return {
    openTime: s.open_time,
    closeTime: s.close_time,
    slotMinutes: s.slot_minutes,
    bookingHorizonDays: s.booking_horizon_days,
    bookingDeadlineDays: s.booking_deadline_days,
    weekdayAvailable: !!s.weekday_available,
    weekendAvailable: !!s.weekend_available,
    closingDate: s.closing_date,
  };
}

export interface RescheduleItem {
  date: string;
  startTime: string;
  endTime: string;
  isResidence?: boolean;
}

export interface RescheduleExecTicket {
  isTicket: boolean;
  action?: TicketChangeAction;
  oldHours?: number;
  newHours?: number;
}

export type RescheduleExecResult =
  | {
      ok: false;
      httpStatus: number;
      error: string;
      code?: string;
      details?: unknown;
    }
  | {
      ok: true;
      newTotal: number;
      oldDays: Array<{ date: string; startTime: string; endTime: string }>;
      newDays: Array<{ date: string; startTime: string; endTime: string }>;
      ticket: RescheduleExecTicket;
      calendarWarning: string | null;
    };

/**
 * 日時変更の枠移動を実行する。成功時は新料金・新旧日時・チケット扱いを返す。
 * @param today 本日（JST・'YYYY-MM-DD'）
 * @param now 現在日時（JST・'YYYY-MM-DD HH:MM:SS'）
 */
export async function executeReschedule(
  env: Env,
  g: BookingGroupRow,
  space: SpaceRow,
  items: RescheduleItem[],
  today: string,
  now: string,
  origin: string,
): Promise<RescheduleExecResult> {
  const db = env.DB;
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, httpStatus: 400, error: 'items は必須です' };
  }

  const settings = await getSystemSettings(db);
  const defaultDeadline = Number(settings.get('default_booking_deadline_days') ?? '0');
  const itemDates = items.map((i) => i.date).sort();
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

  const valSpace = toValidationSpace(space);
  const errors: Array<{ index: number; code: string; message: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const dayType = getDayType(item.date, holidayMap);
    const closures = await getSpaceClosures(db, space.id, item.date, item.date);
    const closed = isClosed(item.date, { holidays: holidayMap, spaceClosureDates: closures });
    for (const e of validateBookingItem(valSpace, item as BookingItemInput, {
      today,
      dayType,
      isClosed: closed,
      defaultDeadlineDays: defaultDeadline,
    })) {
      errors.push({ index: i, ...e });
    }
    const exclusive = isExclusiveDay(toPricingConfig(space), item.date, { holidays: holidayMap, seasonalRules });
    const existing = await getOccupyingIntervalsExcludingGroup(db, space.id, item.date, g.id);
    const conflict = exclusive
      ? existing.length > 0
      : existing.some((b) => intervalsOverlap(item.startTime, item.endTime, b.start_time, b.end_time));
    if (conflict) {
      errors.push({
        index: i,
        code: 'CONFLICT',
        message: exclusive
          ? `${item.date} は1日貸切のため既に埋まっています`
          : `${item.date} ${item.startTime}-${item.endTime} は既に予約があります`,
      });
    }
  }
  if (errors.length > 0) return { ok: false, httpStatus: 409, error: 'validation failed', details: errors };

  // 変更先の枠が Google カレンダー上で空いているか（自分自身のイベントは除外）
  const oldRows = await getBookingsByGroup(db, g.id);
  const calCheck = await checkCalendarConflictExcluding(
    env,
    space.google_calendar_id,
    items,
    oldRows.map((r) => r.google_event_id),
  );
  if (calCheck.conflict) {
    return {
      ok: false,
      httpStatus: 409,
      code: 'CALENDAR_CONFLICT',
      error: `${calCheck.conflict} はGoogleカレンダー上で埋まっています。別の時間をお選びください。`,
    };
  }

  // 新料金
  const dayInputs: DayBookingInput[] = items.map((i) => ({
    date: i.date,
    startTime: i.startTime,
    endTime: i.endTime,
    isResidence: i.isResidence,
  }));
  const newGroup = computeGroupSpacePrice(toPricingConfig(space), dayInputs, { holidays: holidayMap, seasonalRules });

  // チケット払いの再計算（統一ポリシー §4）。当初利用日基準で残日数を判定。
  const ticketUsage = await getTicketUsageForGroup(db, g.id);
  let ticketRecalc: { usageId: string; ticketId: string; newRemaining: number; newHours: number; coveredYen: number } | null = null;
  let ticketInfo: RescheduleExecTicket = { isTicket: false };
  let newTotal: number;
  if (ticketUsage) {
    const oldHours = oldRows.reduce((s, r) => s + r.billable_hours, 0);
    const newHoursTotal = newGroup.days.reduce((s, d) => s + d.billableHours, 0);
    const refDate = g.original_date || oldRows.map((r) => r.date).sort()[0] || today;
    const daysBefore = daysBetween(today, refDate);
    const plan = ticketChangePlan(daysBefore, oldHours, newHoursTotal);
    if (plan.action === 'blocked') {
      return {
        ok: false,
        httpStatus: 400,
        code: 'TICKET_DURATION_FIXED',
        error: plan.message || '当日・前日の時間延長はチケットでは承れません。追加分は新規のご予約をお願いします。',
      };
    }
    // partial_forfeit：減少分は失効（残時間へ戻さない）。残りは付替（新予約で newHoursTotal 消費）。
    // restore_full / move：旧消費を全額戻し、新予約で改めて消費する。
    const restored = plan.action === 'partial_forfeit' ? ticketUsage.remainingHours : ticketUsage.remainingHours + oldHours;
    const cov = coveredAmountForHours(
      newGroup.days.map((d) => ({ billableHours: d.billableHours, price: d.price })),
      restored,
    );
    newTotal = Math.max(0, newGroup.spaceTotal - cov.coveredYen);
    ticketRecalc = {
      usageId: ticketUsage.usageId,
      ticketId: ticketUsage.ticketId,
      newRemaining: restored - cov.coveredHours,
      newHours: cov.coveredHours,
      coveredYen: cov.coveredYen,
    };
    ticketInfo = { isTicket: true, action: plan.action, oldHours, newHours: newHoursTotal };
  } else {
    newTotal = newGroup.spaceTotal;
  }

  // 日程を差し替え（旧bookings削除→新規挿入）＋グループ更新
  const newBookingIds = items.map(() => crypto.randomUUID());
  const ticketStmts = ticketRecalc
    ? buildTicketRescheduleStmts(db, {
        usageId: ticketRecalc.usageId,
        ticketId: ticketRecalc.ticketId,
        newRemaining: ticketRecalc.newRemaining,
        newHours: ticketRecalc.newHours,
        spaceTotal: newGroup.spaceTotal,
        coveredYen: ticketRecalc.coveredYen,
        newFirstBookingId: newBookingIds[0],
        now,
      })
    : null;
  const stmts: D1PreparedStatement[] = [];
  if (ticketStmts) stmts.push(ticketStmts.clearOldUsage);
  stmts.push(db.prepare('DELETE FROM bookings WHERE group_id = ?').bind(g.id));
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const day = newGroup.days[i];
    stmts.push(
      db
        .prepare(
          `INSERT INTO bookings
           (id, group_id, space_id, date, start_time, end_time, billable_hours, billing_mode, is_residence, rate, price, status, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
        )
        .bind(
          newBookingIds[i],
          g.id,
          space.id,
          item.date,
          item.startTime,
          item.endTime,
          day.billableHours,
          day.billingMode,
          day.isResidence ? 1 : 0,
          day.rate,
          day.price,
          g.source,
        ),
    );
  }
  stmts.push(
    db
      .prepare('UPDATE booking_groups SET total_amount = ?, reschedule_count = reschedule_count + 1 WHERE id = ?')
      .bind(newTotal, g.id),
  );
  if (ticketStmts) stmts.push(...ticketStmts.applyNew);
  await db.batch(stmts);

  // Googleカレンダー同期：旧イベントを削除し、新しい日時で作り直す
  let calendarWarning: string | null = null;
  if (space.google_calendar_id) {
    await deleteBookingFromCalendar(env, space.google_calendar_id, oldRows.map((r) => r.google_event_id));
    const res = await syncBookingCalendarEvents(env, g.id, origin);
    calendarWarning = res.warning ?? null;
  }

  return {
    ok: true,
    newTotal,
    oldDays: oldRows.map((r) => ({ date: r.date, startTime: r.start_time, endTime: r.end_time })),
    newDays: items.map((i) => ({ date: i.date, startTime: i.startTime, endTime: i.endTime })),
    ticket: ticketInfo,
    calendarWarning,
  };
}
