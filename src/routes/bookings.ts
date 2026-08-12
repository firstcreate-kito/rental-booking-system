import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  getSpaceById,
  getHolidays,
  getSpaceClosures,
  getActiveSeasonalRules,
  getSpaceBookingsOnDate,
  getOccupyingIntervalsExcludingGroup,
  getSystemSettings,
  isBlacklisted,
  getCustomerByEmail,
  getBookingGroupByNumber,
  getBookingsByGroup,
  getCancelPolicies,
  peekNextBookingSeq,
  type SpaceRow,
} from '../db/repository';
import { getDayType, isClosed, daysBetween, type HolidayType } from '../lib/calendar';
import {
  computeCancelCharge,
  selectCancelPolicy,
  computeAdjustment,
  type CancelPolicyTier,
} from '../lib/cancellation';
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

/**
 * POST /api/bookings/:number/cancel 予約キャンセル
 * ※会員ステータス別のセルフ可否・月間上限の判定は認証実装時に接続する。
 *   本エンドポイントはキャンセル処理とキャンセル料計算を行う。
 */
app.post('/:number/cancel', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (g.status === 'cancelled') return c.json({ error: '既にキャンセル済みです' }, 400);

  const bookings = (await getBookingsByGroup(db, g.id)).filter((b) => b.status !== 'cancelled');
  const policiesAll = await getCancelPolicies(db);
  const tiers: CancelPolicyTier[] = selectCancelPolicy(
    policiesAll.map((p) => ({
      spaceId: p.space_id,
      daysBefore: p.days_before,
      chargePct: p.charge_pct,
      cutoffTime: p.cutoff_time,
    })),
    g.space_id,
  );

  const now = nowJST();
  const today = now.slice(0, 10);
  let totalFee = 0;
  const stmts: D1PreparedStatement[] = [];
  const breakdown: Array<{ date: string; price: number; chargePct: number; cancelFee: number }> = [];

  for (const b of bookings) {
    const charge = computeCancelCharge(tiers, b.date, now, b.price);
    totalFee += charge.cancelFee;
    breakdown.push({ date: b.date, price: b.price, chargePct: charge.chargePct, cancelFee: charge.cancelFee });
    stmts.push(
      db
        .prepare(
          `INSERT INTO cancellation_log
           (id, group_id, booking_id, customer_id, cancelled_at, days_before, charge_pct, original_price, cancel_fee, collection_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .bind(
          crypto.randomUUID(),
          g.id,
          b.id,
          g.customer_id ?? '',
          now,
          daysBetween(today, b.date),
          charge.chargePct,
          b.price,
          charge.cancelFee,
        ),
    );
    stmts.push(db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(b.id));
  }
  stmts.push(db.prepare("UPDATE booking_groups SET status = 'cancelled' WHERE id = ?").bind(g.id));
  await db.batch(stmts);

  return c.json({
    bookingNumber: number,
    status: 'cancelled',
    cancelFee: totalFee,
    breakdown,
    note: 'キャンセル料は管理者が手動で徴収します',
  });
});

/**
 * POST /api/bookings/:number/reschedule 日時変更
 * body: { items: [{date,startTime,endTime,isResidence?}] }
 * ※差額の決済/請求/返金ワークフロー(カード即時・請求書手動・返金)は
 *   決済・認証実装時に接続。本エンドポイントは日程更新と差額の記録を行う。
 */
app.post('/:number/reschedule', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  let body: { items?: Array<{ date: string; startTime: string; endTime: string; isResidence?: boolean }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: 'items は必須です' }, 400);
  }

  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (g.status === 'cancelled') return c.json({ error: 'キャンセル済みの予約は変更できません' }, 400);

  const space = await getSpaceById(db, g.space_id);
  if (!space || !space.is_active) return c.json({ error: 'space not found' }, 404);

  const settings = await getSystemSettings(db);
  const defaultDeadline = Number(settings.get('default_booking_deadline_days') ?? '0');
  const today = todayJST();
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
  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
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
    // 競合（自グループを除く）
    const existing = await getOccupyingIntervalsExcludingGroup(db, space.id, item.date, g.id);
    if (existing.some((b) => intervalsOverlap(item.startTime, item.endTime, b.start_time, b.end_time))) {
      errors.push({ index: i, code: 'CONFLICT', message: `${item.date} ${item.startTime}-${item.endTime} は既に予約があります` });
    }
  }
  if (errors.length > 0) return c.json({ error: 'validation failed', details: errors }, 409);

  // 新料金
  const dayInputs: DayBookingInput[] = body.items.map((i) => ({
    date: i.date,
    startTime: i.startTime,
    endTime: i.endTime,
    isResidence: i.isResidence,
  }));
  const newGroup = computeGroupSpacePrice(toPricingConfig(space), dayInputs, {
    holidays: holidayMap,
    seasonalRules,
  });
  const newTotal = newGroup.spaceTotal;
  const adjustment = computeAdjustment(g.total_amount, newTotal);

  // 日程を差し替え（旧bookingsを削除→新規挿入）+ グループ更新 + 差額記録
  const now = nowJST();
  const stmts: D1PreparedStatement[] = [];
  stmts.push(db.prepare('DELETE FROM bookings WHERE group_id = ?').bind(g.id));
  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    const day = newGroup.days[i];
    stmts.push(
      db
        .prepare(
          `INSERT INTO bookings
           (id, group_id, space_id, date, start_time, end_time, billable_hours, billing_mode, is_residence, rate, price, status, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
        )
        .bind(
          crypto.randomUUID(),
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
  if (adjustment.type !== 'zero') {
    stmts.push(
      db
        .prepare(
          `INSERT INTO booking_adjustments (id, group_id, type, amount, payment_method, status, created_at)
           VALUES (?, ?, ?, ?, 'invoice', 'pending', ?)`,
        )
        .bind(crypto.randomUUID(), g.id, adjustment.type, adjustment.amount, now),
    );
  }
  await db.batch(stmts);

  return c.json({
    bookingNumber: number,
    newTotal,
    adjustment,
    days: newGroup.days.map((d) => ({ date: d.date, billingMode: d.billingMode, price: d.price })),
  });
});

/**
 * POST /api/bookings/:number/change-request 変更リクエスト送信
 * body: { type: 'reschedule'|'option'|'cancel'|'other', message, contact? }
 */
app.post('/:number/change-request', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  let body: { type?: string; message?: string; contact?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const validTypes = ['reschedule', 'option', 'cancel', 'other'];
  if (!body.type || !validTypes.includes(body.type) || !body.message) {
    return c.json({ error: 'type(reschedule/option/cancel/other) と message は必須です' }, 400);
  }
  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO change_requests (id, group_id, customer_id, booking_number, type, message, contact, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(id, g.id, g.customer_id, number, body.type, body.message, body.contact ?? null, nowJST())
    .run();

  // TODO: 管理者への通知メール + 顧客への受付確認メール（通知実装時）
  return c.json({ id, status: 'pending', message: '変更リクエストを受け付けました。担当者よりご連絡します。' }, 201);
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
