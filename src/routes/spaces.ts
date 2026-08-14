import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  getActiveSpaces,
  getSpaceById,
  getHolidays,
  getSpaceClosures,
  getActiveSeasonalRulesForSpace,
  getSpaceBookingsInRange,
  getSpaceBookingsOnDate,
  getSystemSettings,
  getSpaceOptions,
  getDailyOptionUsage,
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
import { todayJST, nowJST } from '../lib/clock';
import { gcalConfigured, freeBusy, busyToDayInterval, toJstRfc3339, type BusyInterval } from '../lib/gcal';

const app = new Hono<AppBindings>();

/** 顧客向けに公開するスペース情報へ整形 */
function toPublicSpace(s: SpaceRow) {
  return {
    id: s.id,
    slug: s.slug,
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

/** GET /api/spaces/:id/options?date=YYYY-MM-DD オプション一覧（在庫情報含む） */
app.get('/:id/options', async (c) => {
  const id = c.req.param('id');
  const date = c.req.query('date');
  const space = await getSpaceById(c.env.DB, id);
  if (!space || !space.is_active) return c.json({ error: 'space not found' }, 404);

  const options = await getSpaceOptions(c.env.DB, id);
  const result = await Promise.all(
    options.map(async (o) => {
      let remaining: number | null = o.stock_total;
      if (date && o.stock_total != null && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const used = await getDailyOptionUsage(c.env.DB, o.id, date);
        remaining = Math.max(0, o.stock_total - used);
      }
      return {
        id: o.id,
        name: o.name,
        category: o.category,
        type: o.type,
        priceType: o.price_type,
        unitPrice: o.unit_price,
        unitLabel: o.unit_label,
        maxQty: o.max_qty,
        stockTotal: o.stock_total,
        remaining, // date指定時はその日の残数
        scope: o.scope,
      };
    }),
  );
  return c.json({ spaceId: id, date: date ?? null, options: result });
});

/** GET /api/spaces/:id/day?date=YYYY-MM-DD その日の予約済み時間帯（時間選択の空き状況バー用） */
app.get('/:id/day', async (c) => {
  const id = c.req.param('id');
  const date = c.req.query('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'date(YYYY-MM-DD) is required' }, 400);
  }
  const space = await getSpaceById(c.env.DB, id);
  if (!space || !space.is_active) return c.json({ error: 'space not found' }, 404);

  const bookings = await getSpaceBookingsOnDate(c.env.DB, id, date);
  // 占有中の予約（確定/商談中/ブロック/仮確保）を時間帯として返す
  const booked = bookings.map((b) => ({
    startTime: b.start_time,
    endTime: b.end_time,
    // 顧客には確定/商談中の区別のみ見せる（商談中はお問い合わせ誘導）
    kind: b.status === 'tentative' ? 'tentative' : 'booked',
  }));

  // Googleカレンダー（台帳の正）の予定も「予約済み」として反映（外部ポータル予約等）
  if (gcalConfigured(c.env) && space.google_calendar_id) {
    try {
      const busy = await freeBusy(
        c.env,
        space.google_calendar_id,
        toJstRfc3339(date, '00:00'),
        toJstRfc3339(date, '23:59'),
      );
      for (const b of busy as BusyInterval[]) {
        const iv = busyToDayInterval(b, date, space.close_time);
        if (iv) booked.push({ startTime: iv.startTime, endTime: iv.endTime, kind: 'booked' });
      }
    } catch {
      // カレンダー照会失敗時はローカルのみで表示（表示を止めない）
    }
  }

  return c.json({
    spaceId: id,
    date,
    openTime: space.open_time,
    closeTime: space.close_time,
    slotMinutes: space.slot_minutes,
    booked,
    today: todayJST(),
    nowTime: nowJST().slice(11, 16), // 当日の過去枠グレーアウト用（JST HH:MM）
  });
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
    getActiveSeasonalRulesForSpace(c.env.DB, id),
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

  // Googleカレンダー（台帳の正）の予定を月分まとめて取得（外部ポータル予約等を空き状況に反映）
  let gcalBusy: BusyInterval[] = [];
  if (gcalConfigured(c.env) && space.google_calendar_id) {
    try {
      gcalBusy = await freeBusy(
        c.env,
        space.google_calendar_id,
        toJstRfc3339(startDate, '00:00'),
        toJstRfc3339(endDate, '23:59'),
      );
    } catch {
      gcalBusy = []; // 照会失敗時はローカルのみ
    }
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
      bookings: [
        ...dayBookings.map((b) => ({
          startTime: b.start_time,
          endTime: b.end_time,
          status: b.status,
        })),
        // Googleカレンダーの予定（外部予約等）も占有として反映
        ...gcalBusy
          .map((b) => busyToDayInterval(b, date, space.close_time))
          .filter((iv): iv is { startTime: string; endTime: string } => iv !== null)
          .map((iv) => ({ startTime: iv.startTime, endTime: iv.endTime, status: 'confirmed' })),
      ],
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
      closed, // 休業日（祝日休業・全体休業日・個別休業）
      past: diff < 0, // 今日より前
    };
  });

  return c.json({ spaceId: id, month, today, days, nextMonthFrom: addDays(endDate, 1) });
});

export default app;
