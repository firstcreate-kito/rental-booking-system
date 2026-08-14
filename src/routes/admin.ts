import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings } from '../types';
import { requireAdmin, requireRole } from '../middleware/admin';
import {
  countAdmins,
  insertAdmin,
  getAdminAuthByEmail,
  createAdminSession,
  deleteAdminSession,
  listBookingsForAdmin,
  getAllSpaces,
  insertSpace,
  updateSpace,
  getSpaceById,
  getHolidaysAll,
  upsertHoliday,
  deleteHoliday,
  getClosuresAll,
  insertClosure,
  deleteClosure,
  getAllOptions,
  getAllOptionSpaceLinks,
  insertOption,
  updateOption,
  setOptionSpaces,
  getOptionsByIds,
  searchCustomers,
  createCustomer,
  couponCodeExists,
  issueCoupon,
  adjustPoints,
  getCustomerProfile,
  getPointBalanceAndLog,
  getMemberCoupons,
  type SpaceInput,
  type OptionInput,
  getHolidays,
  getActiveSeasonalRulesForSpace,
  getSeasonalAll,
  insertSeasonal,
  updateSeasonal,
  deleteSeasonal,
  getCampaignsAll,
  insertCampaign,
  updateCampaign,
  deleteCampaign,
  type SeasonalInput,
  type CampaignInput,
  getSpaceClosures,
  getSpaceBookingsOnDate,
  getOccupyingIntervalsExcludingGroup,
  getCustomerByEmail,
  getBookingGroupByNumber,
  getBookingsByGroup,
  getCancelPolicies,
  peekNextBookingSeq,
  type SpaceRow,
} from '../db/repository';
import { hashPassword, verifyPassword, generateToken, sessionExpiry, isValidEmail } from '../lib/auth';
import { nowJST, todayJST, todayYmdJST } from '../lib/clock';
import { getDayType, isClosed, daysBetween, type HolidayType } from '../lib/calendar';
import { computeCancelCharge, selectCancelPolicy, computeAdjustment, type CancelPolicyTier } from '../lib/cancellation';
import { sendEmail, bookingConfirmationEmail, cancellationEmail, rescheduleEmail, adminRescheduleEmail } from '../lib/email';
import { gcalConfigured, freeBusy, toJstRfc3339 } from '../lib/gcal';
import { checkCalendarConflict, checkCalendarConflictExcluding, writeBookingToCalendar, promoteBookingCalendar, deleteBookingFromCalendar } from '../lib/gcal-sync';
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

/** GET /api/admin/needs-setup 管理者が未登録か（初回セットアップ要否） */
app.get('/needs-setup', async (c) => {
  const needsSetup = (await countAdmins(c.env.DB)) === 0;
  return c.json({ needsSetup, appEnv: c.env.APP_ENV ?? 'development' });
});

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

/** POST /api/admin/calendar-test Googleカレンダー接続テスト（設定確認用） */
app.post('/calendar-test', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const calendarId = String(b.calendarId ?? '').trim();
  const configured = gcalConfigured(c.env);
  if (!configured) {
    return c.json({
      configured: false,
      hasEmail: !!c.env.GOOGLE_SA_EMAIL,
      hasKey: !!c.env.GOOGLE_SA_PRIVATE_KEY,
      error: 'GOOGLE_SA_EMAIL と GOOGLE_SA_PRIVATE_KEY が未設定です（wrangler secret put で登録してください）',
    });
  }
  if (!calendarId) return c.json({ configured: true, error: 'カレンダーIDが未入力です' }, 400);
  // 今日の適当な1時間で freeBusy を試す（読み書き権限・ID・認証の総合チェック）
  const today = todayJST();
  try {
    const busy = await freeBusy(c.env, calendarId, toJstRfc3339(today, '00:00'), toJstRfc3339(today, '23:59'));
    return c.json({ configured: true, ok: true, calendarId, busyCount: busy.length, saEmail: c.env.GOOGLE_SA_EMAIL ?? null });
  } catch (err) {
    return c.json({ configured: true, ok: false, calendarId, error: (err as Error).message, saEmail: c.env.GOOGLE_SA_EMAIL ?? null });
  }
});

/** POST /api/admin/test-email メール送信テスト（設定確認用） */
app.post('/test-email', requireRole('owner', 'manager'), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const to = String(body.to ?? '').trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return c.json({ error: '送信先メールアドレスを入力してください' }, 400);
  }
  const configured = !!(c.env.RESEND_API_KEY && c.env.MAIL_FROM);
  const result = await sendEmail(c.env, {
    to,
    subject: '【レンタルスペースALBE】メール送信テスト',
    html: '<p>これはメール送信設定のテストメールです。この本文が届いていれば、メール送信は正常に動作しています。</p>',
    text: 'これはメール送信設定のテストメールです。この本文が届いていれば、メール送信は正常に動作しています。',
  });
  // 送信元の設定状況も返す（原因切り分け用）
  return c.json({ configured, hasApiKey: !!c.env.RESEND_API_KEY, hasFrom: !!c.env.MAIL_FROM, mailFrom: c.env.MAIL_FROM ?? null, ...result });
});

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
  customer?: { id?: string; contactName?: string; email?: string; phone?: string; companyName?: string };
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
    getActiveSeasonalRulesForSpace(db, space.id),
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
  if (body.customer?.id) {
    // 既存顧客を検索から選択したケース
    const picked = await getCustomerProfile(db, body.customer.id);
    if (picked) customerId = String(picked.id);
  }
  if (!customerId && body.customer?.email) {
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

  // Googleカレンダー（台帳の正）を確定直前に照会。埋まっていれば拒否。
  // 商談中も外部ポータルの予約流入を防ぐため照会・書き込みの対象にする。
  {
    const calCheck = await checkCalendarConflict(c.env, space.google_calendar_id, body.items);
    if (calCheck.conflict) {
      return { error: c.json({ error: `${calCheck.conflict} はGoogleカレンダー上でたった今埋まりました。別の時間をお選びください。`, code: 'CALENDAR_CONFLICT' }, 409) };
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

  // Googleカレンダーへ書き込み（本予約・商談中とも。商談中は【商談中】マーカー付き）
  let calendarWarning: string | null = null;
  if (gcalConfigured(c.env) && space.google_calendar_id) {
    const rows = await getBookingsByGroup(db, inserted.groupId);
    const res = await writeBookingToCalendar(c.env, space.google_calendar_id, {
      bookingNumber: inserted.bookingNumber,
      eventName: body.eventName,
      customerName: body.customer?.contactName ?? 'お客様',
      items: rows.map((r) => ({ date: r.date, startTime: r.start_time, endTime: r.end_time })),
      bookingIds: rows.map((r) => r.id),
      tentative: status === 'tentative',
    });
    calendarWarning = res.warning ?? null;
  }

  // 本予約（confirmed）でお客様のメールが分かる場合のみ、予約確認メールを送る。
  // 商談中（tentative）は社内の仮押さえのため送らない。
  if (status === 'confirmed' && body.customer?.email) {
    const mail = bookingConfirmationEmail({
      bookingNumber: inserted.bookingNumber,
      spaceName: space.name,
      eventName: body.eventName,
      customerName: body.customer.contactName ?? 'お客様',
      days: body.items.map((i) => ({ date: i.date, startTime: i.startTime, endTime: i.endTime })),
      total: group.spaceTotal,
      status: 'confirmed',
    });
    c.executionCtx.waitUntil(sendEmail(c.env, { to: body.customer.email, ...mail }));
  }

  return {
    result: c.json(
      {
        bookingNumber: inserted.bookingNumber,
        groupId: inserted.groupId,
        status,
        total: group.spaceTotal,
        days: group.days.map((d) => ({ date: d.date, billingMode: d.billingMode, price: d.price })),
        calendarWarning,
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

  // 本予約化の直前にGoogleカレンダー（台帳の正）を照会。埋まっていれば拒否。
  // 商談中予約は既に【商談中】イベントとしてカレンダーに存在するため、
  // 自分自身のイベントは除外して外部予約とのみ重複チェックする。
  const confirmSpace = await getSpaceById(db, g.space_id);
  const items = bookings.map((b) => ({ date: b.date, startTime: b.start_time, endTime: b.end_time }));
  const calCheck = await checkCalendarConflictExcluding(
    c.env,
    confirmSpace?.google_calendar_id ?? null,
    items,
    bookings.map((b) => b.google_event_id),
  );
  if (calCheck.conflict) {
    return c.json({ error: `${calCheck.conflict} はGoogleカレンダー上で埋まっています。本予約化できません。`, code: 'CALENDAR_CONFLICT' }, 409);
  }

  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE booking_groups SET status = 'confirmed' WHERE id = ?").bind(g.id),
    db.prepare("UPDATE bookings SET status = 'confirmed' WHERE group_id = ? AND status = 'tentative'").bind(g.id),
  ];
  await db.batch(stmts);

  // 本予約化 → 既存の【商談中】イベントのタイトルを通常表示に更新（無ければ作成）
  let calendarWarning: string | null = null;
  if (gcalConfigured(c.env) && confirmSpace?.google_calendar_id) {
    const cust = g.customer_id ? await getCustomerProfile(db, g.customer_id) : null;
    const res = await promoteBookingCalendar(c.env, confirmSpace.google_calendar_id, {
      bookingNumber: number,
      eventName: g.event_name,
      customerName: cust?.contact_name ? String(cust.contact_name) : (g.event_name || 'お客様'),
      rows: bookings,
    });
    calendarWarning = res.warning ?? null;
  }
  return c.json({ bookingNumber: number, status: 'confirmed', calendarWarning });
});

/** 予約グループのキャンセル料を日別に計算（キャンセルはしない） */
async function computeGroupCancel(db: D1Database, spaceId: string, bookings: Array<{ id: string; date: string; price: number; status: string }>, now: string) {
  const policiesAll = await getCancelPolicies(db);
  const tiers: CancelPolicyTier[] = selectCancelPolicy(
    policiesAll.map((p) => ({ spaceId: p.space_id, daysBefore: p.days_before, chargePct: p.charge_pct, cutoffTime: p.cutoff_time })),
    spaceId,
  );
  const today = now.slice(0, 10);
  let totalFee = 0;
  const breakdown = bookings
    .filter((b) => b.status !== 'cancelled')
    .map((b) => {
      const charge = computeCancelCharge(tiers, b.date, now, b.price);
      totalFee += charge.cancelFee;
      return { bookingId: b.id, date: b.date, price: b.price, daysBefore: daysBetween(today, b.date), chargePct: charge.chargePct, cancelFee: charge.cancelFee };
    });
  return { totalFee, breakdown };
}

/** GET /api/admin/bookings/:number/cancel-preview キャンセル料の事前確認 */
app.get('/bookings/:number/cancel-preview', async (c) => {
  const db = c.env.DB;
  const g = await getBookingGroupByNumber(db, c.req.param('number'));
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (g.status === 'cancelled') return c.json({ error: '既にキャンセル済みです' }, 400);
  const bookings = await getBookingsByGroup(db, g.id);
  const { totalFee, breakdown } = await computeGroupCancel(db, g.space_id, bookings, nowJST());
  return c.json({ bookingNumber: g.booking_number, status: g.status, totalFee, breakdown });
});

/** POST /api/admin/bookings/:number/cancel 本予約のキャンセル（キャンセル料計算・記録） */
app.post('/bookings/:number/cancel', async (c) => {
  const db = c.env.DB;
  const g = await getBookingGroupByNumber(db, c.req.param('number'));
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (g.status === 'cancelled') return c.json({ error: '既にキャンセル済みです' }, 400);
  if (g.status === 'tentative') return c.json({ error: '商談中は「解除」を使ってください' }, 400);

  const bookings = await getBookingsByGroup(db, g.id);
  const now = nowJST();
  const { totalFee, breakdown } = await computeGroupCancel(db, g.space_id, bookings, now);

  const stmts: D1PreparedStatement[] = [];
  for (const b of breakdown) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO cancellation_log
           (id, group_id, booking_id, customer_id, cancelled_at, days_before, charge_pct, original_price, cancel_fee, collection_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .bind(crypto.randomUUID(), g.id, b.bookingId, g.customer_id ?? '', now, b.daysBefore, b.chargePct, b.price, b.cancelFee),
    );
    stmts.push(db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(b.bookingId));
  }
  stmts.push(db.prepare("UPDATE booking_groups SET status = 'cancelled' WHERE id = ?").bind(g.id));
  await db.batch(stmts);

  // Googleカレンダー（台帳の正）からイベント削除
  const cancelSpace = await getSpaceById(db, g.space_id);
  await deleteBookingFromCalendar(c.env, cancelSpace?.google_calendar_id ?? null, bookings.map((b) => b.google_event_id));

  // キャンセル確認メール（お客様宛）
  if (g.customer_id) {
    const [prof, sp] = await Promise.all([getCustomerProfile(db, g.customer_id), getSpaceById(db, g.space_id)]);
    const to = prof?.email ? String(prof.email) : '';
    if (to) {
      const mail = cancellationEmail({
        bookingNumber: g.booking_number,
        spaceName: sp?.name ?? '',
        customerName: prof?.contact_name ? String(prof.contact_name) : 'お客様',
        cancelFee: totalFee,
      });
      c.executionCtx.waitUntil(sendEmail(c.env, { to, ...mail }));
    }
  }

  return c.json({ bookingNumber: g.booking_number, status: 'cancelled', cancelFee: totalFee, breakdown, note: 'キャンセル料は管理者が手動で徴収します' });
});

/**
 * POST /api/admin/bookings/:number/release 商談中の解除（キャンセル）
 * 商談が流れた場合に枠を空ける。キャンセル料は発生しない（本予約ではないため）。
 */
app.post('/bookings/:number/release', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (g.status !== 'tentative') {
    return c.json({ error: '商談中の予約のみ解除できます（本予約はキャンセル操作から）' }, 400);
  }
  const relBookings = await getBookingsByGroup(db, g.id);
  await db.batch([
    db.prepare("UPDATE booking_groups SET status = 'cancelled' WHERE id = ?").bind(g.id),
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE group_id = ?").bind(g.id),
  ]);
  // 商談中もカレンダーに書き込んでいるため、解除時はイベントを削除
  const relSpace = await getSpaceById(db, g.space_id);
  await deleteBookingFromCalendar(c.env, relSpace?.google_calendar_id ?? null, relBookings.map((b) => b.google_event_id));
  return c.json({ bookingNumber: number, status: 'cancelled' });
});

/**
 * GET /api/admin/bookings/:number 予約グループの明細（日時変更モーダル用）
 */
app.get('/bookings/:number', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);
  const space = await getSpaceById(db, g.space_id);
  const rows = await getBookingsByGroup(db, g.id);
  return c.json({
    bookingNumber: g.booking_number,
    status: g.status,
    eventName: g.event_name,
    spaceName: space?.name ?? '',
    totalAmount: g.total_amount,
    items: rows.map((r) => ({
      date: r.date,
      startTime: r.start_time,
      endTime: r.end_time,
      isResidence: !!r.is_residence,
    })),
  });
});

/**
 * POST /api/admin/bookings/:number/reschedule 日時変更（管理者）
 * body: { items: [{date,startTime,endTime,isResidence?}] }
 * 管理者は受付期間（締切/受付開始）の制約を無視できる。休業日・競合は不可。
 */
app.post('/bookings/:number/reschedule', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const body = (await c.req.json().catch(() => ({}))) as { items?: Array<{ date: string; startTime: string; endTime: string; isResidence?: boolean }> };
  if (!Array.isArray(body.items) || body.items.length === 0) return c.json({ error: 'items は必須です' }, 400);

  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (g.status === 'cancelled') return c.json({ error: 'キャンセル済みの予約は変更できません' }, 400);
  const space = await getSpaceById(db, g.space_id);
  if (!space) return c.json({ error: 'space not found' }, 404);

  const itemDates = body.items.map((i) => i.date).sort();
  const [holidays, seasonalRows] = await Promise.all([
    getHolidays(db, itemDates[0], itemDates[itemDates.length - 1]),
    getActiveSeasonalRulesForSpace(db, space.id),
  ]);
  const holidayMap = holidays as ReadonlyMap<string, HolidayType>;
  const seasonalRules: SeasonalRule[] = seasonalRows.map((r) => ({ startDate: r.start_date, endDate: r.end_date, surchargePct: r.surcharge_pct }));

  // 休業日・競合チェック（受付期間の制約は管理者につき無視）
  for (const item of body.items) {
    const closures = await getSpaceClosures(db, space.id, item.date, item.date);
    if (isClosed(item.date, { holidays: holidayMap, spaceClosureDates: closures })) {
      return c.json({ error: `${item.date} は休業日です` }, 409);
    }
    const existing = await getOccupyingIntervalsExcludingGroup(db, space.id, item.date, g.id);
    if (existing.some((b) => intervalsOverlap(item.startTime, item.endTime, b.start_time, b.end_time))) {
      return c.json({ error: `${item.date} ${item.startTime}-${item.endTime} は既に予約があります` }, 409);
    }
  }

  // Googleカレンダー：変更先の空き照会（自分自身のイベントは除外）
  const oldRows = await getBookingsByGroup(db, g.id);
  const calCheck = await checkCalendarConflictExcluding(c.env, space.google_calendar_id, body.items, oldRows.map((r) => r.google_event_id));
  if (calCheck.conflict) {
    return c.json({ error: `${calCheck.conflict} はGoogleカレンダー上で埋まっています。別の時間をお選びください。`, code: 'CALENDAR_CONFLICT' }, 409);
  }

  const keepStatus = g.status === 'tentative' ? 'tentative' : 'confirmed';
  const isTentative = keepStatus === 'tentative';

  const dayInputs: DayBookingInput[] = body.items.map((i) => ({ date: i.date, startTime: i.startTime, endTime: i.endTime, isResidence: i.isResidence }));
  const newGroup = computeGroupSpacePrice(toPricingConfig(space), dayInputs, { holidays: holidayMap, seasonalRules });
  // 商談中（仮予約）は金額が未確定のため再計算・差額計算は行わず、日時のみ移動する。
  // 本予約（代理予約含む）は通常どおり料金を再計算し差額を返す。
  const newTotal = isTentative ? g.total_amount : newGroup.spaceTotal;
  const adjustment = isTentative ? null : computeAdjustment(g.total_amount, newTotal);

  const newBookingIds = body.items.map(() => crypto.randomUUID());
  const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM bookings WHERE group_id = ?').bind(g.id)];
  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    const day = newGroup.days[i];
    stmts.push(
      db
        .prepare(
          `INSERT INTO bookings
           (id, group_id, space_id, date, start_time, end_time, billable_hours, billing_mode, is_residence, rate, price, status, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(newBookingIds[i], g.id, space.id, item.date, item.startTime, item.endTime, day.billableHours, day.billingMode, day.isResidence ? 1 : 0, day.rate, day.price, keepStatus, g.source),
    );
  }
  // 商談中は total_amount を据え置き（reschedule_count のみ更新）
  stmts.push(
    isTentative
      ? db.prepare('UPDATE booking_groups SET reschedule_count = reschedule_count + 1 WHERE id = ?').bind(g.id)
      : db.prepare('UPDATE booking_groups SET total_amount = ?, reschedule_count = reschedule_count + 1 WHERE id = ?').bind(newTotal, g.id),
  );
  await db.batch(stmts);

  const cust = g.customer_id ? await getCustomerProfile(db, g.customer_id) : null;
  const custName = cust?.contact_name ? String(cust.contact_name) : (g.event_name || 'お客様');

  // Googleカレンダー同期：旧イベント削除→新日時で作成
  let calendarWarning: string | null = null;
  if (space.google_calendar_id) {
    await deleteBookingFromCalendar(c.env, space.google_calendar_id, oldRows.map((r) => r.google_event_id));
    const res = await writeBookingToCalendar(c.env, space.google_calendar_id, {
      bookingNumber: number,
      eventName: g.event_name,
      customerName: custName,
      items: body.items,
      bookingIds: newBookingIds,
      tentative: keepStatus === 'tentative',
    });
    calendarWarning = res.warning ?? null;
  }

  // 変更通知メール（お客様＋管理者）。商談中は金額を伏せる。
  const oldDays = oldRows.map((r) => ({ date: r.date, startTime: r.start_time, endTime: r.end_time }));
  const newDays = body.items.map((i) => ({ date: i.date, startTime: i.startTime, endTime: i.endTime }));
  const mailData = {
    bookingNumber: number,
    spaceName: space.name,
    eventName: g.event_name,
    customerName: custName,
    oldDays,
    newDays,
    total: newTotal,
    status: keepStatus as 'confirmed' | 'tentative',
    showAmount: !isTentative,
  };
  const custEmail = cust?.email ? String(cust.email) : '';
  if (custEmail) {
    c.executionCtx.waitUntil(sendEmail(c.env, { to: custEmail, ...rescheduleEmail(mailData) }));
  }
  if (c.env.MAIL_ADMIN) {
    const adminMail = adminRescheduleEmail({ ...mailData, customerEmail: custEmail || undefined, customerPhone: cust?.phone ? String(cust.phone) : undefined });
    c.executionCtx.waitUntil(sendEmail(c.env, { to: c.env.MAIL_ADMIN, ...adminMail }));
  }

  return c.json({ bookingNumber: number, newTotal, adjustment, calendarWarning });
});

// ---------------------------------------------------------------------------
// スペース設定（マスタ管理）※owner / manager のみ変更可
// ---------------------------------------------------------------------------

function parseSpaceInput(body: Record<string, unknown>): { input?: SpaceInput; error?: string } {
  const name = String(body.name ?? '').trim();
  if (!name) return { error: 'スペース名は必須です' };
  const billingType = body.billingType === 'block' ? 'block' : 'hourly';
  const openTime = String(body.openTime ?? '').trim();
  const closeTime = String(body.closeTime ?? '').trim();
  const timeRe = /^\d{1,2}:\d{2}$/;
  if (!timeRe.test(openTime) || !timeRe.test(closeTime)) {
    return { error: '営業時間は HH:MM 形式で入力してください' };
  }
  const num = (v: unknown): number | null => (v === '' || v == null ? null : Number(v));
  const slug = body.slug ? String(body.slug).trim() : null;
  if (slug && !/^[a-z0-9-]+$/.test(slug)) {
    return { error: 'スラッグは半角英小文字・数字・ハイフンのみ使用できます' };
  }
  const input: SpaceInput = {
    name,
    nameEn: body.nameEn ? String(body.nameEn) : null,
    slug,
    googleCalendarId: body.googleCalendarId ? String(body.googleCalendarId).trim() : null,
    billingType,
    weekdayRate: num(body.weekdayRate),
    weekendRate: num(body.weekendRate),
    dayRateHours: num(body.dayRateHours),
    weekdayAvailable: body.weekdayAvailable !== false,
    weekendAvailable: body.weekendAvailable !== false,
    slotMinutes: Number(body.slotMinutes ?? 30),
    hasMinimum: body.hasMinimum !== false,
    minHours: Number(body.minHours ?? 1),
    openTime,
    closeTime,
    bookingHorizonDays: Number(body.bookingHorizonDays ?? 180),
    bookingDeadlineDays: num(body.bookingDeadlineDays),
    blockName: body.blockName ? String(body.blockName) : null,
    sortOrder: Number(body.sortOrder ?? 0),
    isActive: body.isActive !== false,
  };
  return { input };
}

/** GET /api/admin/spaces スペース一覧（非公開含む） */
app.get('/spaces', async (c) => {
  const spaces = await getAllSpaces(c.env.DB);
  return c.json({ spaces });
});

/** POST /api/admin/spaces スペース追加（owner/manager） */
app.post('/spaces', requireRole('owner', 'manager'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { input, error } = parseSpaceInput(body as Record<string, unknown>);
  if (error || !input) return c.json({ error: error ?? 'invalid input' }, 400);
  const id = String((body as Record<string, unknown>).id ?? '').trim() || crypto.randomUUID();
  try {
    await insertSpace(c.env.DB, id, input);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('UNIQUE')) return c.json({ error: 'IDまたはスラッグが既に使われています' }, 409);
    throw err;
  }
  return c.json({ id, ...input }, 201);
});

/** PUT /api/admin/spaces/:id スペース編集（owner/manager） */
app.put('/spaces/:id', requireRole('owner', 'manager'), async (c) => {
  const id = c.req.param('id');
  const existing = await getSpaceById(c.env.DB, id);
  if (!existing) return c.json({ error: 'space not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const { input, error } = parseSpaceInput(body as Record<string, unknown>);
  if (error || !input) return c.json({ error: error ?? 'invalid input' }, 400);
  try {
    await updateSpace(c.env.DB, id, input);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('UNIQUE')) return c.json({ error: 'スラッグが既に使われています' }, 409);
    throw err;
  }
  return c.json({ id, ...input });
});

// ---------------------------------------------------------------------------
// 顧客管理・特典（クーポン発行・ポイント付与）
// ---------------------------------------------------------------------------

/** GET /api/admin/customers?q= 顧客検索 */
app.get('/customers', async (c) => {
  const customers = await searchCustomers(c.env.DB, (c.req.query('q') ?? '').trim());
  return c.json({ customers });
});

/** GET /api/admin/customers/:id 顧客詳細（プロフィール + ポイント + クーポン） */
app.get('/customers/:id', async (c) => {
  const id = c.req.param('id');
  const profile = await getCustomerProfile(c.env.DB, id);
  if (!profile) return c.json({ error: 'customer not found' }, 404);
  const [points, coupons] = await Promise.all([
    getPointBalanceAndLog(c.env.DB, id),
    getMemberCoupons(c.env.DB, id),
  ]);
  return c.json({ profile, points, coupons });
});

/** POST /api/admin/customers 新規顧客の手動登録（owner/manager） */
app.post('/customers', requireRole('owner', 'manager'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const b = body as Record<string, unknown>;
  const contactName = String(b.contactName ?? '').trim();
  const email = String(b.email ?? '').trim();
  const phone = String(b.phone ?? '').trim();
  const companyName = String(b.companyName ?? '').trim();
  if (!contactName) return c.json({ error: 'お名前は必須です' }, 400);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'メールアドレスの形式が正しくありません' }, 400);
  if (email) {
    const existing = await getCustomerByEmail(c.env.DB, email);
    if (existing) return c.json({ error: 'このメールアドレスの顧客は既に登録されています', id: existing.id }, 409);
  }
  const id = await createCustomer(
    c.env.DB,
    { email: email || null, contactName, phone: phone || null, companyName: companyName || null },
    nowJST(),
  );
  return c.json({ id }, 201);
});

/** POST /api/admin/coupons クーポン発行（owner/manager） */
app.post('/coupons', requireRole('owner', 'manager'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const b = body as Record<string, unknown>;
  const customerId = String(b.customerId ?? '').trim();
  const name = String(b.name ?? '').trim();
  const discountType = b.discountType === 'fixed' ? 'fixed' : 'percent';
  const discountValue = Number(b.discountValue ?? 0);
  const totalHours = Number(b.totalHours ?? 0);
  // 有効開始: 未指定なら発行日（本日）から。有効終了: 未指定なら無期限（null）。
  const validFrom = String(b.validFrom ?? '').trim() || todayJST();
  const validUntilRaw = String(b.validUntil ?? '').trim();
  const validUntil = validUntilRaw === '' ? null : validUntilRaw;
  const spaceIds = Array.isArray(b.spaceIds) ? (b.spaceIds as unknown[]).map(String) : [];
  if (!customerId || !name) return c.json({ error: '顧客・名称は必須です' }, 400);
  if (discountValue <= 0 || totalHours <= 0) return c.json({ error: '割引値・時間は1以上で入力してください' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) {
    return c.json({ error: '有効開始日は YYYY-MM-DD で入力してください' }, 400);
  }
  if (validUntil !== null && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
    return c.json({ error: '有効終了日は YYYY-MM-DD で入力してください' }, 400);
  }
  if (validUntil !== null && validUntil < validFrom) {
    return c.json({ error: '有効終了日は開始日以降にしてください' }, 400);
  }
  if (spaceIds.length === 0) return c.json({ error: '対象スペースを1つ以上選んでください' }, 400);
  // コードは6桁のランダム数字で自動採番（全体でユニークになるまで再試行）
  let code = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = String((crypto.getRandomValues(new Uint32Array(1))[0] % 900000) + 100000);
    if (!(await couponCodeExists(c.env.DB, candidate))) {
      code = candidate;
      break;
    }
  }
  if (!code) return c.json({ error: 'コードの採番に失敗しました。もう一度お試しください' }, 500);
  try {
    const id = await issueCoupon(
      c.env.DB,
      { customerId, name, code, discountType, discountValue, totalHours, validFrom, validUntil, staffMemo: b.staffMemo ? String(b.staffMemo) : null, spaceIds },
      c.get('admin').id,
      nowJST(),
    );
    return c.json({ id, code }, 201);
  } catch (err) {
    if ((err as Error).message?.includes('UNIQUE')) return c.json({ error: 'このクーポンコードは既に使われています' }, 409);
    throw err;
  }
});

/** POST /api/admin/customers/:id/points ポイント手動付与/取消（owner/manager） */
app.post('/customers/:id/points', requireRole('owner', 'manager'), async (c) => {
  const id = c.req.param('id');
  const profile = await getCustomerProfile(c.env.DB, id);
  if (!profile) return c.json({ error: 'customer not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const amount = Number((body as Record<string, unknown>).amount ?? 0);
  const type = (body as Record<string, unknown>).type === 'remove' ? 'remove' : 'add';
  if (!Number.isInteger(amount) || amount <= 0) return c.json({ error: 'ポイントは1以上の整数で入力してください' }, 400);
  const { balanceAfter } = await adjustPoints(
    c.env.DB,
    id,
    { amount, type, description: (body as Record<string, unknown>).description ? String((body as Record<string, unknown>).description) : null },
    c.get('admin').id,
    nowJST(),
  );
  return c.json({ balanceAfter });
});

// ---------------------------------------------------------------------------
// オプション管理（マスタ）※owner / manager
// ---------------------------------------------------------------------------
function parseOptionInput(body: Record<string, unknown>): { input?: OptionInput; spaceIds?: string[]; error?: string } {
  const name = String(body.name ?? '').trim();
  if (!name) return { error: 'オプション名は必須です' };
  const type = body.type === 'quantity' ? 'quantity' : 'toggle';
  const priceType = ['free', 'fixed', 'per_unit'].includes(String(body.priceType)) ? (body.priceType as OptionInput['priceType']) : 'free';
  const scope = body.scope === 'per_booking' ? 'per_booking' : 'per_group';
  const num = (v: unknown): number | null => (v === '' || v == null ? null : Number(v));
  const input: OptionInput = {
    name,
    category: String(body.category ?? 'その他').trim() || 'その他',
    type,
    priceType,
    unitPrice: Number(body.unitPrice ?? 0),
    unitLabel: body.unitLabel ? String(body.unitLabel) : null,
    maxQty: num(body.maxQty),
    stockTotal: num(body.stockTotal),
    scope,
    sortOrder: Number(body.sortOrder ?? 0),
    isActive: body.isActive !== false,
  };
  const spaceIds = Array.isArray(body.spaceIds) ? (body.spaceIds as unknown[]).map(String) : [];
  return { input, spaceIds };
}

/** GET /api/admin/options オプション一覧（対象スペース含む） */
app.get('/options', async (c) => {
  const [options, links] = await Promise.all([getAllOptions(c.env.DB), getAllOptionSpaceLinks(c.env.DB)]);
  const byOption = new Map<string, string[]>();
  for (const l of links) {
    const arr = byOption.get(l.option_id) ?? [];
    arr.push(l.space_id);
    byOption.set(l.option_id, arr);
  }
  return c.json({ options: options.map((o) => ({ ...o, space_ids: byOption.get(o.id) ?? [] })) });
});

/** POST /api/admin/options オプション追加（owner/manager） */
app.post('/options', requireRole('owner', 'manager'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { input, spaceIds, error } = parseOptionInput(body as Record<string, unknown>);
  if (error || !input) return c.json({ error: error ?? 'invalid input' }, 400);
  const id = crypto.randomUUID();
  await insertOption(c.env.DB, id, input);
  await setOptionSpaces(c.env.DB, id, spaceIds ?? []);
  return c.json({ id, ...input, space_ids: spaceIds }, 201);
});

/** PUT /api/admin/options/:id オプション編集（owner/manager） */
app.put('/options/:id', requireRole('owner', 'manager'), async (c) => {
  const id = c.req.param('id');
  const existing = await getOptionsByIds(c.env.DB, [id]);
  if (!existing.has(id)) return c.json({ error: 'option not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const { input, spaceIds, error } = parseOptionInput(body as Record<string, unknown>);
  if (error || !input) return c.json({ error: error ?? 'invalid input' }, 400);
  await updateOption(c.env.DB, id, input);
  await setOptionSpaces(c.env.DB, id, spaceIds ?? []);
  return c.json({ id, ...input, space_ids: spaceIds });
});

// ---------------------------------------------------------------------------
// カレンダー管理（休業日・祝日・スペース別休業）※owner / manager
// ---------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/admin/holidays?from=&to= 祝日・全体休業日一覧 */
app.get('/holidays', async (c) => {
  const holidays = await getHolidaysAll(c.env.DB, c.req.query('from'), c.req.query('to'));
  return c.json({ holidays });
});

/** POST /api/admin/holidays 祝日/休業日を追加（type: holiday/custom/closed） */
app.post('/holidays', requireRole('owner', 'manager'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const date = String(body.date ?? '').trim();
  const type = body.type;
  if (!DATE_RE.test(date)) return c.json({ error: '日付は YYYY-MM-DD 形式で入力してください' }, 400);
  if (!['holiday', 'custom', 'closed'].includes(type)) {
    return c.json({ error: 'type は holiday / custom / closed のいずれかです' }, 400);
  }
  await upsertHoliday(c.env.DB, { date, name: body.name ? String(body.name) : null, type });
  return c.json({ date, name: body.name ?? null, type }, 201);
});

/** DELETE /api/admin/holidays/:date */
app.delete('/holidays/:date', requireRole('owner', 'manager'), async (c) => {
  await deleteHoliday(c.env.DB, c.req.param('date'));
  return c.json({ ok: true });
});

/** GET /api/admin/closures?spaceId= スペース別休業日一覧 */
app.get('/closures', async (c) => {
  const closures = await getClosuresAll(c.env.DB, c.req.query('spaceId'));
  return c.json({ closures });
});

/** POST /api/admin/closures スペース別休業日を追加 */
app.post('/closures', requireRole('owner', 'manager'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const spaceId = String(body.spaceId ?? '').trim();
  const date = String(body.date ?? '').trim();
  if (!spaceId || !DATE_RE.test(date)) return c.json({ error: 'spaceId と 日付(YYYY-MM-DD) は必須です' }, 400);
  await insertClosure(c.env.DB, { spaceId, date, reason: body.reason ? String(body.reason) : null });
  return c.json({ ok: true }, 201);
});

/** DELETE /api/admin/closures/:id */
app.delete('/closures/:id', requireRole('owner', 'manager'), async (c) => {
  await deleteClosure(c.env.DB, c.req.param('id'));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 季節料金・キャンペーン（マスタ管理）※owner / manager
// ---------------------------------------------------------------------------

/** 季節料金の入力を検証して SeasonalInput に整形 */
function parseSeasonalInput(b: Record<string, unknown>): { input?: SeasonalInput; error?: string } {
  const name = String(b.name ?? '').trim();
  const startDate = String(b.startDate ?? '').trim();
  const endDate = String(b.endDate ?? '').trim();
  const surchargePct = Number(b.surchargePct ?? 0);
  const isActive = b.isActive === undefined ? true : !!b.isActive;
  const spaceIds = Array.isArray(b.spaceIds) ? (b.spaceIds as unknown[]).map(String) : [];
  if (!name) return { error: '名称は必須です' };
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) return { error: '期間は YYYY-MM-DD で入力してください' };
  if (endDate < startDate) return { error: '終了日は開始日以降にしてください' };
  if (!Number.isFinite(surchargePct) || surchargePct <= 0) return { error: '割増率（％）は1以上で入力してください' };
  return { input: { name, startDate, endDate, surchargePct: Math.round(surchargePct), isActive, spaceIds } };
}

/** GET /api/admin/seasonal 季節料金一覧 */
app.get('/seasonal', async (c) => {
  const seasonal = await getSeasonalAll(c.env.DB);
  return c.json({ seasonal });
});

/** POST /api/admin/seasonal 季節料金を追加 */
app.post('/seasonal', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { input, error } = parseSeasonalInput(b);
  if (error || !input) return c.json({ error: error ?? 'invalid input' }, 400);
  const id = await insertSeasonal(c.env.DB, input);
  return c.json({ id }, 201);
});

/** PUT /api/admin/seasonal/:id 季節料金を更新 */
app.put('/seasonal/:id', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { input, error } = parseSeasonalInput(b);
  if (error || !input) return c.json({ error: error ?? 'invalid input' }, 400);
  await updateSeasonal(c.env.DB, c.req.param('id'), input);
  return c.json({ ok: true });
});

/** DELETE /api/admin/seasonal/:id 季節料金を削除 */
app.delete('/seasonal/:id', requireRole('owner', 'manager'), async (c) => {
  await deleteSeasonal(c.env.DB, c.req.param('id'));
  return c.json({ ok: true });
});

/** キャンペーンの入力を検証して CampaignInput に整形 */
function parseCampaignInput(b: Record<string, unknown>): { input?: CampaignInput; error?: string } {
  const name = String(b.name ?? '').trim();
  const startDate = String(b.startDate ?? '').trim();
  const endDate = String(b.endDate ?? '').trim();
  const discountType = b.discountType === 'fixed' ? 'fixed' : 'percent';
  const discountValue = Number(b.discountValue ?? 0);
  const applyWeekday = b.applyWeekday === undefined ? true : !!b.applyWeekday;
  const applyWeekend = b.applyWeekend === undefined ? true : !!b.applyWeekend;
  const spaceIdRaw = String(b.spaceId ?? '').trim();
  const spaceId = spaceIdRaw === '' ? null : spaceIdRaw;
  const isActive = b.isActive === undefined ? true : !!b.isActive;
  if (!name) return { error: '名称は必須です' };
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) return { error: '期間は YYYY-MM-DD で入力してください' };
  if (endDate < startDate) return { error: '終了日は開始日以降にしてください' };
  if (!Number.isFinite(discountValue) || discountValue <= 0) return { error: '割引値は1以上で入力してください' };
  if (discountType === 'percent' && discountValue > 100) return { error: '％割引は100以下で入力してください' };
  if (!applyWeekday && !applyWeekend) return { error: '平日・土日祝の少なくとも一方を対象にしてください' };
  return {
    input: { name, startDate, endDate, discountType, discountValue: Math.round(discountValue), applyWeekday, applyWeekend, spaceId, isActive },
  };
}

/** GET /api/admin/campaigns キャンペーン一覧 */
app.get('/campaigns', async (c) => {
  const campaigns = await getCampaignsAll(c.env.DB);
  return c.json({ campaigns });
});

/** POST /api/admin/campaigns キャンペーンを追加 */
app.post('/campaigns', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { input, error } = parseCampaignInput(b);
  if (error || !input) return c.json({ error: error ?? 'invalid input' }, 400);
  const id = await insertCampaign(c.env.DB, input);
  return c.json({ id }, 201);
});

/** PUT /api/admin/campaigns/:id キャンペーンを更新 */
app.put('/campaigns/:id', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { input, error } = parseCampaignInput(b);
  if (error || !input) return c.json({ error: error ?? 'invalid input' }, 400);
  await updateCampaign(c.env.DB, c.req.param('id'), input);
  return c.json({ ok: true });
});

/** DELETE /api/admin/campaigns/:id キャンペーンを削除 */
app.delete('/campaigns/:id', requireRole('owner', 'manager'), async (c) => {
  await deleteCampaign(c.env.DB, c.req.param('id'));
  return c.json({ ok: true });
});

export default app;
