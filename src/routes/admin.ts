import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings } from '../types';
import { requireAdmin } from '../middleware/admin';
import {
  countAdmins,
  insertAdmin,
  getAdminAuthByEmail,
  createAdminSession,
  deleteAdminSession,
  listBookingsForAdmin,
  getSpaceById,
  getHolidays,
  getActiveSeasonalRules,
  getSpaceClosures,
  getSpaceBookingsOnDate,
  getCustomerByEmail,
  getBookingGroupByNumber,
  getBookingsByGroup,
  peekNextBookingSeq,
  type SpaceRow,
} from '../db/repository';
import { hashPassword, verifyPassword, generateToken, sessionExpiry, isValidEmail } from '../lib/auth';
import { nowJST, todayJST, todayYmdJST } from '../lib/clock';
import { getDayType, isClosed, type HolidayType } from '../lib/calendar';
import {
  computeGroupSpacePrice,
  type SpacePricingConfig,
  type SeasonalRule,
  type DayBookingInput,
} from '../lib/pricing';
import {
  validateBookingItem,
  intervalsOverlap,
  type BookingValidationSpace,
  type BookingItemInput,
} from '../lib/availability';

const app = new Hono<AppBindings>();

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

// ---------------------------------------------------------------------------
// 管理者認証
// ---------------------------------------------------------------------------

/** POST /api/admin/setup 初回のオーナー作成（管理者が未登録のときのみ） */
app.post('/setup', async (c) => {
  const db = c.env.DB;
  if ((await countAdmins(db)) > 0) {
    return c.json({ error: '管理者は既に存在します' }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const { email, password, name } = body as { email?: string; password?: string; name?: string };
  if (!email || !isValidEmail(email) || !password || password.length < 8 || !name) {
    return c.json({ error: 'email, 8文字以上のpassword, name が必要です' }, 400);
  }
  const id = crypto.randomUUID();
  await insertAdmin(db, { id, email, passwordHash: await hashPassword(password), name, role: 'owner' });
  return c.json({ id, email, name, role: 'owner' }, 201);
});

/** POST /api/admin/login */
app.post('/login', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const { email, password } = body as { email?: string; password?: string };
  if (!email || !password) return c.json({ error: 'メールとパスワードは必須です' }, 400);

  const admin = await getAdminAuthByEmail(db, email);
  if (!admin || !admin.is_active) return c.json({ error: 'メールまたはパスワードが違います' }, 401);
  if (!(await verifyPassword(password, admin.password_hash))) {
    return c.json({ error: 'メールまたはパスワードが違います' }, 401);
  }
  const now = nowJST();
  const token = generateToken();
  await createAdminSession(db, token, admin.id, sessionExpiry(), now);
  return c.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } });
});

/** POST /api/admin/logout */
app.post('/logout', async (c) => {
  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (token) await deleteAdminSession(c.env.DB, token);
  return c.json({ ok: true });
});

// 以降は管理者ログイン必須
app.use('/*', requireAdmin);

// ---------------------------------------------------------------------------
// 予約管理
// ---------------------------------------------------------------------------

/** GET /api/admin/bookings 予約一覧（?from=&to=&spaceId=&status=） */
app.get('/bookings', async (c) => {
  const rows = await listBookingsForAdmin(c.env.DB, {
    from: c.req.query('from'),
    to: c.req.query('to'),
    spaceId: c.req.query('spaceId'),
    status: c.req.query('status'),
  });
  return c.json({ bookings: rows });
});

interface AdminBookingItem {
  date: string;
  startTime: string;
  endTime: string;
  isResidence?: boolean;
}

interface AdminBookingBody {
  spaceId: string;
  eventName: string;
  items: AdminBookingItem[];
  customer?: { contactName?: string; email?: string; phone?: string; companyName?: string };
  note?: string;
}

/**
 * 予約グループ+予約を採番して挿入する内部ヘルパー。
 * @param status 'confirmed' | 'tentative'
 */
async function insertBookingGroup(
  db: D1Database,
  params: {
    space: SpaceRow;
    eventName: string;
    customerId: string | null;
    days: ReturnType<typeof computeGroupSpacePrice>['days'];
    items: AdminBookingItem[];
    total: number;
    status: 'confirmed' | 'tentative';
    note: string | null;
  },
): Promise<{ bookingNumber: string; groupId: string }> {
  const ymd = todayYmdJST();
  const groupId = crypto.randomUUID();
  const now = nowJST();
  let bookingNumber = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await peekNextBookingSeq(db, ymd);
    bookingNumber = `${ymd}-${String(seq).padStart(3, '0')}`;
    const stmts: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO booking_groups (id, booking_number, customer_id, space_id, event_name, total_amount, status, source, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?)`,
        )
        .bind(groupId, bookingNumber, params.customerId, params.space.id, params.eventName, params.total, params.status, params.note, now),
    ];
    for (let i = 0; i < params.items.length; i++) {
      const item = params.items[i];
      const day = params.days[i];
      stmts.push(
        db
          .prepare(
            `INSERT INTO bookings
             (id, group_id, space_id, date, start_time, end_time, billable_hours, billing_mode, is_residence, rate, price, status, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin')`,
          )
          .bind(
            crypto.randomUUID(),
            groupId,
            params.space.id,
            item.date,
            item.startTime,
            item.endTime,
            day.billableHours,
            day.billingMode,
            day.isResidence ? 1 : 0,
            day.rate,
            day.price,
            params.status,
          ),
      );
    }
    try {
      await db.batch(stmts);
      return { bookingNumber, groupId };
    } catch (err) {
      if ((err as Error).message?.includes('UNIQUE') && attempt < 4) continue;
      throw err;
    }
  }
  return { bookingNumber, groupId };
}

/** 予約作成の共通処理（proxy/tentative） */
async function prepareAdminBooking(
  c: Context<AppBindings>,
  status: 'confirmed' | 'tentative',
) {
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => null)) as AdminBookingBody | null;
  if (!body || !body.spaceId || !body.eventName || !Array.isArray(body.items) || body.items.length === 0) {
    return { error: c.json({ error: 'spaceId, eventName, items は必須です' }, 400) };
  }
  const space = await getSpaceById(db, body.spaceId);
  if (!space || !space.is_active) return { error: c.json({ error: 'space not found' }, 404) };

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

  // バリデーション（管理者は受付期間の制約を無視）+ 競合
  const valSpace = toValidationSpace(space);
  const skip = new Set(['BEYOND_HORIZON', 'PAST_DEADLINE', 'PAST_DATE']);
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
      defaultDeadlineDays: 0,
    })) {
      if (!skip.has(e.code)) errors.push({ index: i, ...e });
    }
    const existing = await getSpaceBookingsOnDate(db, space.id, item.date);
    if (existing.some((b) => intervalsOverlap(item.startTime, item.endTime, b.start_time, b.end_time))) {
      errors.push({ index: i, code: 'CONFLICT', message: `${item.date} ${item.startTime}-${item.endTime} は既に予約があります` });
    }
  }
  if (errors.length > 0) return { error: c.json({ error: 'validation failed', details: errors }, 409) };

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

  // 顧客（任意）
  let customerId: string | null = null;
  if (body.customer?.email) {
    const existing = await getCustomerByEmail(db, body.customer.email);
    if (existing) {
      customerId = existing.id;
    } else if (body.customer.contactName && body.customer.phone) {
      customerId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO customers (id, email, is_registered, company_name, contact_name, phone, status_id, created_at)
           VALUES (?, ?, 0, ?, ?, ?, 'general', ?)`,
        )
        .bind(customerId, body.customer.email, body.customer.companyName ?? null, body.customer.contactName, body.customer.phone, nowJST())
        .run();
    }
  }

  const inserted = await insertBookingGroup(db, {
    space,
    eventName: body.eventName,
    customerId,
    days: group.days,
    items: body.items,
    total: group.spaceTotal,
    status,
    note: body.note ?? null,
  });

  return {
    result: c.json(
      {
        bookingNumber: inserted.bookingNumber,
        groupId: inserted.groupId,
        status,
        total: group.spaceTotal,
        days: group.days.map((d) => ({ date: d.date, billingMode: d.billingMode, price: d.price })),
      },
      201,
    ),
  };
}

/** POST /api/admin/bookings 代理予約（本予約） */
app.post('/bookings', async (c) => {
  const out = await prepareAdminBooking(c, 'confirmed');
  return out.error ?? out.result!;
});

/** POST /api/admin/bookings/tentative 仮予約（商談中）作成 */
app.post('/bookings/tentative', async (c) => {
  const out = await prepareAdminBooking(c, 'tentative');
  return out.error ?? out.result!;
});

/** POST /api/admin/bookings/:number/confirm 商談中 → 本予約 */
app.post('/bookings/:number/confirm', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (g.status !== 'tentative') return c.json({ error: '商談中の予約ではありません' }, 400);

  const bookings = await getBookingsByGroup(db, g.id);
  // 確定直前の競合再チェック（他の確定予約と重ならないか）
  for (const b of bookings) {
    const existing = await getSpaceBookingsOnDate(db, g.space_id, b.date);
    const conflict = existing.some(
      (e) =>
        e.status === 'confirmed' &&
        intervalsOverlap(b.start_time, b.end_time, e.start_time, e.end_time),
    );
    if (conflict) return c.json({ error: `${b.date} は既に確定予約と競合しています` }, 409);
  }

  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE booking_groups SET status = 'confirmed' WHERE id = ?").bind(g.id),
    db.prepare("UPDATE bookings SET status = 'confirmed' WHERE group_id = ? AND status = 'tentative'").bind(g.id),
  ];
  await db.batch(stmts);
  return c.json({ bookingNumber: number, status: 'confirmed' });
});

export default app;
