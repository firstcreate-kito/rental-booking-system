import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  getSpaceById,
  getHolidays,
  getSpaceClosures,
  getActiveSeasonalRules,
  getSpaceBookingsOnDate,
  getSystemSettings,
  isBlacklisted,
  getCustomerByEmail,
  peekNextBookingSeq,
  type SpaceRow,
} from '../db/repository';
import { getDayType, isClosed, type HolidayType } from '../lib/calendar';
import {
  computeGroupSpacePrice,
  type SpacePricingConfig,
  type SeasonalRule,
  type DayBookingInput,
} from '../lib/pricing';
import { applyDiscounts, type DiscountableDay } from '../lib/discounts';
import {
  validateBookingItem,
  intervalsOverlap,
  type BookingValidationSpace,
  type BookingItemInput,
} from '../lib/availability';
import { todayJST, todayYmdJST, nowJST } from '../lib/clock';

const app = new Hono<AppBindings>();

const BLACKLIST_MESSAGE = '申し訳ございませんが、ご予約をお受けすることができません。';

interface CreateBookingBody {
  spaceId: string;
  eventName: string;
  customer: {
    contactName: string;
    email: string;
    phone: string;
    companyName?: string;
  };
  items: Array<{ date: string; startTime: string; endTime: string; isResidence?: boolean }>;
}

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
  };
}

/** POST /api/bookings 予約作成（ゲスト対応・スペース料金のみ） */
app.post('/', async (c) => {
  const db = c.env.DB;
  let body: CreateBookingBody;
  try {
    body = await c.req.json<CreateBookingBody>();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  // 入力の基本チェック
  if (!body.spaceId || !body.eventName || !body.customer || !Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: 'spaceId, eventName, customer, items は必須です' }, 400);
  }
  const { contactName, email, phone, companyName } = body.customer ?? {};
  if (!contactName || !email || !phone) {
    return c.json({ error: 'お名前・メール・電話は必須です' }, 400);
  }

  const space = await getSpaceById(db, body.spaceId);
  if (!space || !space.is_active) return c.json({ error: 'space not found' }, 404);

  // ブラックリストチェック（理由・連絡先は返さない）
  if (await isBlacklisted(db, email, phone)) {
    return c.json({ error: BLACKLIST_MESSAGE }, 403);
  }

  const settings = await getSystemSettings(db);
  const defaultDeadline = Number(settings.get('default_booking_deadline_days') ?? '0');
  const today = todayJST();

  // 期間の祝日・季節料金
  const itemDates = body.items.map((i) => i.date).sort();
  const [holidays, seasonalRows] = await Promise.all([
    getHolidays(db, itemDates[0], itemDates[itemDates.length - 1]),
    getActiveSeasonalRules(db),
  ]);
  const holidayMap = holidays as ReadonlyMap<string, HolidayType>;
  const seasonalRules: SeasonalRule[] = seasonalRows.map((r) => ({
    startDate: r.start_date,
    endDate: r.end_date,
    surchargePct: r.surcharge_pct,
  }));

  const valSpace = toValidationSpace(space);
  const errors: Array<{ index: number; code: string; message: string }> = [];

  // バリデーション + 競合チェック
  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    const dayType = getDayType(item.date, holidayMap);
    const closures = await getSpaceClosures(db, space.id, item.date, item.date);
    const closed = isClosed(item.date, { holidays: holidayMap, spaceClosureDates: closures });

    const itemErrors = validateBookingItem(valSpace, item as BookingItemInput, {
      today,
      dayType,
      isClosed: closed,
      defaultDeadlineDays: defaultDeadline,
    });
    for (const e of itemErrors) errors.push({ index: i, ...e });

    // 競合チェック（占有予約と時間帯が重なるか）
    const existing = await getSpaceBookingsOnDate(db, space.id, item.date);
    const conflict = existing.some((b) =>
      intervalsOverlap(item.startTime, item.endTime, b.start_time, b.end_time),
    );
    if (conflict) {
      errors.push({ index: i, code: 'CONFLICT', message: `${item.date} ${item.startTime}-${item.endTime} は既に予約があります` });
    }
  }

  if (errors.length > 0) {
    return c.json({ error: 'validation failed', details: errors }, 409);
  }

  // 料金計算（ゲストは割引なし・オプションなし）
  const dayInputs: DayBookingInput[] = body.items.map((i) => ({
    date: i.date,
    startTime: i.startTime,
    endTime: i.endTime,
    isResidence: i.isResidence,
  }));
  const group = computeGroupSpacePrice(toPricingConfig(space), dayInputs, {
    holidays: holidayMap,
    seasonalRules,
  });
  const discountableDays: DiscountableDay[] = group.days.map((d) => ({
    billableHours: d.billableHours,
    price: d.price,
  }));
  const pointRate = Number(settings.get('point_rate') ?? '1');
  const totals = applyDiscounts({
    days: discountableDays,
    primary: { kind: 'none' },
    optionsTotal: 0,
    pointRate,
  });

  // 顧客（ゲスト）: 既存を再利用、なければ作成
  const existingCustomer = await getCustomerByEmail(db, email);
  if (existingCustomer?.is_blocked) {
    return c.json({ error: BLACKLIST_MESSAGE }, 403);
  }
  let customerId = existingCustomer?.id;
  const now = nowJST();
  if (!customerId) {
    customerId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO customers (id, email, is_registered, company_name, contact_name, phone, status_id, created_at)
         VALUES (?, ?, 0, ?, ?, ?, 'general', ?)`,
      )
      .bind(customerId, email, companyName ?? null, contactName, phone, now)
      .run();
  }

  // 予約番号採番 + 挿入（UNIQUE衝突時はリトライ）
  const ymd = todayYmdJST();
  const groupId = crypto.randomUUID();
  let bookingNumber = '';
  let inserted = false;
  for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
    const seq = await peekNextBookingSeq(db, ymd);
    bookingNumber = `${ymd}-${String(seq).padStart(3, '0')}`;
    const stmts: D1PreparedStatement[] = [];
    stmts.push(
      db
        .prepare(
          `INSERT INTO booking_groups (id, booking_number, customer_id, space_id, event_name, total_amount, status, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'web', ?)`,
        )
        .bind(groupId, bookingNumber, customerId, space.id, body.eventName, totals.total, now),
    );
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];
      const day = group.days[i];
      stmts.push(
        db
          .prepare(
            `INSERT INTO bookings
             (id, group_id, space_id, date, start_time, end_time, billable_hours, billing_mode, is_residence, rate, price, status, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'web')`,
          )
          .bind(
            crypto.randomUUID(),
            groupId,
            space.id,
            item.date,
            item.startTime,
            item.endTime,
            day.billableHours,
            day.billingMode,
            day.isResidence ? 1 : 0,
            day.rate,
            day.price,
          ),
      );
    }
    try {
      await db.batch(stmts);
      inserted = true;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('UNIQUE') && attempt < 4) continue; // 採番衝突 → リトライ
      throw err;
    }
  }

  return c.json(
    {
      bookingNumber,
      groupId,
      total: totals.total,
      pointsEarned: totals.pointsEarned,
      days: group.days.map((d) => ({
        date: d.date,
        dayType: d.dayType,
        billingMode: d.billingMode,
        billableHours: d.billableHours,
        price: d.price,
        isResidence: d.isResidence,
      })),
    },
    201,
  );
});

/** GET /api/bookings/:number 予約取得（番号指定） */
app.get('/:number', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const g = await db
    .prepare(
      `SELECT id, booking_number, space_id, event_name, total_amount, status, created_at
       FROM booking_groups WHERE booking_number = ?`,
    )
    .bind(number)
    .first<{
      id: string;
      booking_number: string;
      space_id: string;
      event_name: string;
      total_amount: number;
      status: string;
      created_at: string;
    }>();
  if (!g) return c.json({ error: 'booking not found' }, 404);

  const { results: days } = await db
    .prepare(
      `SELECT date, start_time, end_time, billable_hours, billing_mode, is_residence, price, status
       FROM bookings WHERE group_id = ? ORDER BY date, start_time`,
    )
    .bind(g.id)
    .all();

  return c.json({
    bookingNumber: g.booking_number,
    spaceId: g.space_id,
    eventName: g.event_name,
    total: g.total_amount,
    status: g.status,
    createdAt: g.created_at,
    days,
  });
});

export default app;
