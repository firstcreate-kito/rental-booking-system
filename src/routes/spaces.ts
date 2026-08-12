import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  getActiveSpaces,
  getSpaceById,
  getHolidays,
  getSpaceClosures,
  getActiveSeasonalRules,
  getSpaceBookingsInRange,
  getSystemSettings,
  type SpaceRow,
} from '../db/repository';
import {
  getDayType,
  isClosed,
  daysBetween,
  datesInMonth,
  addDays,
  type HolidayType,
} from '../lib/calendar';
import { findSeasonalPct, type SeasonalRule } from '../lib/pricing';
import { computeDayAvailability, statusSymbol } from '../lib/availability';
import { todayJST } from '../lib/clock';

const app = new Hono<AppBindings>();

/** 顧客向けに公開するスペース情報へ整形 */
function toPublicSpace(s: SpaceRow) {
  return {
    id: s.id,
    name: s.name,
    billingType: s.billing_type,
    weekdayRate: s.weekday_rate,
    weekendRate: s.weekend_rate,
    dayRateHours: s.day_rate_hours,
    openTime: s.open_time,
    closeTime: s.close_time,
    slotMinutes: s.slot_minutes,
    hasMinimum: !!s.has_minimum,
    minHours: s.min_hours,
    bookingHorizonDays: s.booking_horizon_days,
    weekdayAvailable: !!s.weekday_available,
    weekendAvailable: !!s.weekend_available,
  };
}

/** GET /api/spaces スペース一覧 */
app.get('/', async (c) => {
  const spaces = await getActiveSpaces(c.env.DB);
  return c.json({ spaces: spaces.map(toPublicSpace) });
});

/** GET /api/spaces/:id 単一スペース */
app.get('/:id', async (c) => {
  const space = await getSpaceById(c.env.DB, c.req.param('id'));
  if (!space || !space.is_active) return c.json({ error: 'space not found' }, 404);
  return c.json({ space: toPublicSpace(space) });
});

/** GET /api/spaces/:id/slots?month=YYYY-MM 月間の稼働状況 */
app.get('/:id/slots', async (c) => {
  const id = c.req.param('id');
  const month = c.req.query('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return c.json({ error: 'month(YYYY-MM) is required' }, 400);
  }

  const space = await getSpaceById(c.env.DB, id);
  if (!space || !space.is_active) return c.json({ error: 'space not found' }, 404);

  const dates = datesInMonth(month);
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  const [holidays, closures, seasonalRows, bookings, settings] = await Promise.all([
    getHolidays(c.env.DB, startDate, endDate),
    getSpaceClosures(c.env.DB, id, startDate, endDate),
    getActiveSeasonalRules(c.env.DB),
    getSpaceBookingsInRange(c.env.DB, id, startDate, endDate),
    getSystemSettings(c.env.DB),
  ]);

  const seasonalRules: SeasonalRule[] = seasonalRows.map((r) => ({
    startDate: r.start_date,
    endDate: r.end_date,
    surchargePct: r.surcharge_pct,
  }));
  const thresholdPct = Number(settings.get('availability_threshold') ?? '50');
  const defaultDeadline = Number(settings.get('default_booking_deadline_days') ?? '0');
  const today = todayJST();

  // 日付ごとに予約をグルーピング
  const byDate = new Map<string, typeof bookings>();
  for (const b of bookings) {
    const arr = byDate.get(b.date) ?? [];
    arr.push(b);
    byDate.set(b.date, arr);
  }

  const holidayMap = holidays as ReadonlyMap<string, HolidayType>;
  const days = dates.map((date) => {
    const dayType = getDayType(date, holidayMap);
    const closed = isClosed(date, { holidays: holidayMap, spaceClosureDates: closures });
    const dayAvailable = dayType === 'weekend' ? !!space.weekend_available : !!space.weekday_available;
    const dayBookings = byDate.get(date) ?? [];

    const avail = computeDayAvailability({
      billingType: space.billing_type,
      openTime: space.open_time,
      closeTime: space.close_time,
      slotMinutes: space.slot_minutes,
      isClosed: closed,
      dayAvailable,
      bookings: dayBookings.map((b) => ({
        startTime: b.start_time,
        endTime: b.end_time,
        status: b.status,
      })),
      thresholdPct,
    });

    // 予約受付期間内か
    const diff = daysBetween(today, date);
    const deadline = space.booking_deadline_days ?? defaultDeadline;
    const withinWindow = diff >= deadline && diff <= space.booking_horizon_days;
    const bookable =
      withinWindow && !closed && dayAvailable && avail.status !== 'full';

    return {
      date,
      dayType,
      status: avail.status,
      symbol: statusSymbol(avail.status),
      hasTentative: avail.hasTentative,
      isSeasonal: findSeasonalPct(date, seasonalRules) > 0,
      freeSlots: avail.freeSlots,
      totalSlots: avail.totalSlots,
      bookable,
    };
  });

  return c.json({ spaceId: id, month, today, days, nextMonthFrom: addDays(endDate, 1) });
});

export default app;
