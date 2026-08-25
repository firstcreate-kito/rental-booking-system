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
  getBookingsForExport,
  getCustomersForExport,
  getSalesSummaryForExport,
  getAllSpaces,
  insertSpace,
  updateSpace,
  getSpaceById,
  getSpaceCancelPolicyRows,
  setSpaceCancelPolicyTiers,
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
  setCustomerBlocked,
  getPointBalanceAndLog,
  getMemberCoupons,
  getMemberTickets,
  issueTicket,
  updateIssuedTicket,
  getIssuedTicket,
  getTicketUsageForGroup,
  buildTicketRescheduleStmts,
  getTicketProducts,
  getTicketProduct,
  insertTicketProduct,
  updateTicketProduct,
  deleteTicketProduct,
  type TicketProductInput,
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
  refundBookingPoints,
  peekNextBookingSeq,
  setSystemSetting,
  getSystemSettings,
  createDocumentForGroup,
  listDocumentsForAdmin,
  getSpaceOptions,
  isOptionAvailableForSpace,
  getDailyOptionUsage,
  getSpaceQuestionsAdmin,
  insertSpaceQuestion,
  updateSpaceQuestion,
  deleteSpaceQuestion,
  getBookingAnswers,
  listChangeRequests,
  getChangeRequestById,
  resolveChangeRequest,
  listViewingRequests,
  getViewingRequest,
  updateViewingRequest,
  type SpaceQuestionInput,
  type SpaceRow,
  getRefundablePaymentForGroup,
  addRefundedAmount,
  recordRefundLog,
  getRefundLogForGroup,
  createBookingPayment,
  reissueReceiptForGroup,
  recordBookingEvent,
  getBookingEventsForGroup,
} from '../db/repository';
import { refundPaymentAmount, retrievePaymentIntentMethodType, createCheckoutSession, stripeConfigured } from '../lib/stripe';
import { refundPaypalCapture, paypalConfigured } from '../lib/paypal';
import { refundModeFor, maxRefundable, validateRefundAmount } from '../lib/refund-policy';
import { optionSubtotal, normalizeQuantity, hasStock } from '../lib/options';
import { hashPassword, verifyPassword, generateToken, sessionExpiry, isValidEmail, ADMIN_SESSION_IDLE_MINUTES } from '../lib/auth';
import { buildXlsx, type Sheet } from '../lib/xlsx';
import { nowJST, todayJST, todayYmdJST, addDaysJST } from '../lib/clock';
import { getDayType, isClosed, type HolidayType } from '../lib/calendar';
import { computeAdjustment } from '../lib/cancellation';
import { computeGroupCancel } from '../lib/cancellation-service';
import { sendEmail, bookingConfirmationEmail, cancellationEmail, adminCancellationEmail, rescheduleEmail, adminRescheduleEmail, changeRequestRejectedEmail, adminPaymentActionAlertEmail, additionalChargeEmail, viewingConfirmedEmail, viewingProposedEmail, viewingDeclinedEmail } from '../lib/email';
import { VIEWING_DURATION_MIN } from '../lib/viewing';
import { notifyPaymentConfirmed, adminRecipients } from '../lib/notify';
import { gcalConfigured, freeBusy, toJstRfc3339 } from '../lib/gcal';
import { checkCalendarConflict, checkCalendarConflictExcluding, syncBookingCalendarEvents, deleteBookingFromCalendar } from '../lib/gcal-sync';
import {
  computeGroupSpacePrice,
  type SpacePricingConfig,
  type SeasonalRule,
  type DayBookingInput,
} from '../lib/pricing';
import { seasonalCampaignConflict, coveredAmountForHours, type SeasonalPeriod } from '../lib/discounts';
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
  await createAdminSession(db, token, admin.id, sessionExpiry(ADMIN_SESSION_IDLE_MINUTES), now);
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

/**
 * GET /api/admin/system-status システム連携モード診断（#84）
 * ステージング／本番で「今どのモードで動いているか」を安全に確認するための一覧。
 * 秘密値（APIキー等）は一切返さず、モード（test/live・sandbox/live）と
 * 設定済みか否か（boolean）だけを返す。Stripeのモードは鍵の接頭辞から判定
 * （sk_live→本番／sk_test→テスト）。鍵そのものは応答に含めない。
 */
app.get('/system-status', requireRole('owner', 'manager'), (c) => {
  const env = c.env;
  const sk = (env.STRIPE_SECRET_KEY ?? '').trim();
  const stripeMode = sk.startsWith('sk_live') ? 'live' : sk.startsWith('sk_test') ? 'test' : 'unknown';
  const paypalMode = env.PAYPAL_MODE?.trim() === 'live' ? 'live' : 'sandbox';
  return c.json({
    appEnv: env.APP_ENV ?? 'unknown',
    commit: env.GIT_SHA?.trim() || null,
    publicBaseUrl: env.PUBLIC_BASE_URL ?? null,
    gate: { basicAuth: !!(env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS) },
    payments: {
      stripe: { configured: stripeConfigured(env), mode: stripeMode, konbini: env.STRIPE_KONBINI_ENABLED === 'true' },
      paypal: { configured: paypalConfigured(env), mode: paypalMode },
    },
    email: { configured: !!(env.RESEND_API_KEY && env.MAIL_FROM), adminRecipient: !!env.MAIL_ADMIN },
    calendar: { configured: gcalConfigured(env) },
    logins: {
      google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      line: !!(env.LINE_CHANNEL_ID && env.LINE_CHANNEL_SECRET),
    },
    pdf: { configured: !!(env.CF_ACCOUNT_ID && env.CF_BROWSER_API_TOKEN) },
    retention: { anonymizeEnabled: env.ANONYMIZE_ENABLED === 'true' },
  });
});

/**
 * GET /api/admin/pending-tickets 付与待ちチケット一覧（#82 既存チケットの移行）
 * メール一致で会員へ自動付与する「付与待ち」の状況を確認する。?view=unclaimed|claimed|all
 */
app.get('/pending-tickets', requireRole('owner', 'manager'), async (c) => {
  const db = c.env.DB;
  const view = c.req.query('view') || 'all';
  const where = view === 'unclaimed' ? 'WHERE claimed_at IS NULL' : view === 'claimed' ? 'WHERE claimed_at IS NOT NULL' : '';
  try {
    const { results } = await db
      .prepare(`SELECT id, email, name, scope, remaining_hours, valid_until, legacy_code, note, claimed_at FROM pending_tickets ${where} ORDER BY claimed_at IS NOT NULL, name`)
      .all();
    const rows = results || [];
    const summary = await db
      .prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN claimed_at IS NULL THEN 1 ELSE 0 END) AS unclaimed, SUM(remaining_hours) AS hours FROM pending_tickets')
      .first<{ total: number; unclaimed: number; hours: number }>();
    return c.json({
      items: rows,
      summary: { total: summary?.total ?? 0, unclaimed: summary?.unclaimed ?? 0, claimed: (summary?.total ?? 0) - (summary?.unclaimed ?? 0), hours: summary?.hours ?? 0 },
    });
  } catch (e) {
    // テーブル未作成（マイグレーション未適用）でも管理画面を壊さない
    return c.json({ items: [], summary: { total: 0, unclaimed: 0, claimed: 0, hours: 0 } });
  }
});

// ---------------------------------------------------------------------------
// 予約管理
// ---------------------------------------------------------------------------

/** GET /api/admin/bookings 予約一覧（?from=&to=&spaceId=&status=） */
app.get('/bookings', async (c) => {
  const viewQ = c.req.query('view');
  const view =
    viewQ === 'archive' ? 'archive' : viewQ === 'past' ? 'past' : viewQ === 'active' ? 'active' : undefined;
  const rows = await listBookingsForAdmin(c.env.DB, {
    from: c.req.query('from'),
    to: c.req.query('to'),
    spaceId: c.req.query('spaceId'),
    status: c.req.query('status'),
    view,
    todayYmd: todayJST(), // b.date は 'YYYY-MM-DD' 形式なので同形式で比較する
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
  overrideTotal?: number; // 代理予約の料金を手動指定（優遇・割引用 #30）。単一日程のみ
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
  // 当初利用日（変更・キャンセル判定の基準・以後不変）＝グループ内で最も早い利用日（#76）
  const originalDate = params.items.map((it) => it.date).sort()[0];
  let bookingNumber = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await peekNextBookingSeq(db, ymd);
    bookingNumber = `${ymd}-${String(seq).padStart(3, '0')}`;
    const stmts: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO booking_groups (id, booking_number, customer_id, space_id, event_name, total_amount, original_total_amount, original_date, status, source, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?)`,
        )
        .bind(groupId, bookingNumber, params.customerId, params.space.id, params.eventName, params.total, params.total, originalDate, params.status, params.note, now),
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

  // 代理予約（本予約）の料金を手動で上書き（優遇・割引 #30）。単一日程のみ対応。
  if (
    status === 'confirmed' &&
    typeof body.overrideTotal === 'number' &&
    Number.isFinite(body.overrideTotal) &&
    body.overrideTotal >= 0 &&
    group.days.length === 1
  ) {
    const ov = Math.round(body.overrideTotal);
    group.days[0].price = ov;
    group.spaceTotal = ov;
  }

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

  // Googleカレンダーへリッチ内容で書き込み（本予約・商談中とも）#54関連
  const adminOrigin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  const res = await syncBookingCalendarEvents(c.env, inserted.groupId, adminOrigin);
  const calendarWarning = res.warning ?? null;

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

  // 本予約化 → カレンダー予定をリッチ内容（【予約完了】）に更新（#54関連）
  const promoteOrigin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  const res = await syncBookingCalendarEvents(c.env, g.id, promoteOrigin);
  const calendarWarning = res.warning ?? null;
  return c.json({ bookingNumber: number, status: 'confirmed', calendarWarning });
});

/** GET /api/admin/bookings/:number/cancel-preview キャンセル料の事前確認 */
app.get('/bookings/:number/cancel-preview', async (c) => {
  const db = c.env.DB;
  const g = await getBookingGroupByNumber(db, c.req.param('number'));
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (g.status === 'cancelled') return c.json({ error: '既にキャンセル済みです' }, 400);
  const bookings = await getBookingsByGroup(db, g.id);
  const { totalFee, breakdown } = await computeGroupCancel(db, g.space_id, bookings, nowJST(), g.original_date);
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
  const { totalFee, breakdown } = await computeGroupCancel(db, g.space_id, bookings, now, g.original_date);

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

  // キャンセル時は、この予約で使用したポイントを返還する（#78改）
  if (g.customer_id) await refundBookingPoints(db, g.id, g.customer_id, now);

  // Googleカレンダー（台帳の正）からイベント削除
  const cancelSpace = await getSpaceById(db, g.space_id);
  await deleteBookingFromCalendar(c.env, cancelSpace?.google_calendar_id ?? null, bookings.map((b) => b.google_event_id));

  // キャンセル確認メール（お客様宛）＋管理者通知（#48）
  if (g.customer_id) {
    const [prof, sp] = await Promise.all([getCustomerProfile(db, g.customer_id), getSpaceById(db, g.space_id)]);
    const to = prof?.email ? String(prof.email) : '';
    const custName = prof?.contact_name ? String(prof.contact_name) : 'お客様';
    if (to) {
      const mail = cancellationEmail({ bookingNumber: g.booking_number, spaceName: sp?.name ?? '', customerName: custName, cancelFee: totalFee });
      c.executionCtx.waitUntil(sendEmail(c.env, { to, ...mail }));
    }
    const admins = await adminRecipients(c.env, g.space_id);
    if (admins.length) {
      const adminMail = adminCancellationEmail({
        bookingNumber: g.booking_number,
        spaceName: sp?.name ?? '',
        customerName: custName,
        customerEmail: to || undefined,
        customerPhone: prof?.phone ? String(prof.phone) : undefined,
        cancelFee: totalFee,
      });
      c.executionCtx.waitUntil(sendEmail(c.env, { to: admins, ...adminMail }));
      // 返金が生じる場合のみ、返金対応要アラートを発信（#63/#64）
      const paidAmount = g.payment_status === 'paid' ? g.total_amount : 0;
      const refundDue = Math.max(0, paidAmount - totalFee);
      if (refundDue > 0) {
        const alert = adminPaymentActionAlertEmail({
          kind: 'cancel',
          action: 'refund',
          amount: refundDue,
          bookingNumber: g.booking_number,
          spaceName: sp?.name ?? '',
          customerName: custName,
          customerEmail: to || undefined,
          customerPhone: prof?.phone ? String(prof.phone) : undefined,
          paymentMethod: g.payment_method,
          paymentStatus: g.payment_status,
          cancelFee: totalFee,
          paidAmount,
          adminUrl: `${c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin}/admin.html?booking=${encodeURIComponent(g.booking_number)}`,
        });
        c.executionCtx.waitUntil(sendEmail(c.env, { to: admins, ...alert }));
      }
    }
  }

  try {
    const adminC = c.get('admin');
    await recordBookingEvent(db, { groupId: g.id, type: 'cancel', amount: totalFee, summary: totalFee > 0 ? `キャンセル（キャンセル料 ¥${Math.round(totalFee).toLocaleString('ja-JP')}）` : 'キャンセル（キャンセル料なし）', actor: adminC?.email ? 'admin:' + adminC.email : 'admin' }, nowJST());
  } catch { /* 履歴記録の失敗はキャンセル処理に影響させない */ }
  return c.json({ bookingNumber: g.booking_number, status: 'cancelled', cancelFee: totalFee, breakdown, note: 'キャンセル料は管理者が手動で徴収します' });
});

/** GET /api/admin/bookings/:number/history 予約の変更履歴（管理用）#93 */
app.get('/bookings/:number/history', async (c) => {
  const db = c.env.DB;
  const g = await getBookingGroupByNumber(db, c.req.param('number'));
  if (!g) return c.json({ error: 'booking not found' }, 404);
  const events = await getBookingEventsForGroup(db, g.id);
  return c.json({ events });
});

/**
 * GET /api/admin/bookings/:number/refund-info
 * 返金モーダル用の情報。支払い方法・入金額・返金済み・返金可能額・返金方法
 * （カード/PayPal=自動、銀行振込/コンビニ=手動）・返金履歴を返す。
 */
app.get('/bookings/:number/refund-info', async (c) => {
  const db = c.env.DB;
  const g = await getBookingGroupByNumber(db, c.req.param('number'));
  if (!g) return c.json({ error: 'booking not found' }, 404);
  const pay = await getRefundablePaymentForGroup(db, g.id);
  const paidAmount = g.payment_status === 'paid' ? (pay?.amount ?? g.total_amount) : 0;
  const refunded = pay?.refunded_amount ?? 0;
  const max = maxRefundable(g.payment_status, paidAmount, refunded);
  // Stripe の実支払い種類（カード/コンビニ）を確認して自動/手動を切り分ける
  let stripeType: string | null = null;
  const _pi = pay?.stripe_payment_intent;
  const _sk = c.env.STRIPE_SECRET_KEY;
  if (g.payment_method === 'stripe' && _pi && _sk) {
    stripeType = await retrievePaymentIntentMethodType(_sk, _pi);
  }
  const mode = refundModeFor(g.payment_method, stripeType);
  const history = await getRefundLogForGroup(db, g.id);
  return c.json({
    bookingNumber: g.booking_number,
    paymentMethod: g.payment_method,
    paymentStatus: g.payment_status,
    stripeMethodType: stripeType,
    paidAmount,
    refundedAmount: refunded,
    maxRefundable: max,
    refundMode: mode, // 'auto_stripe' | 'auto_paypal' | 'manual'
    canAuto: mode !== 'manual' && max > 0 && !!(pay && (pay.stripe_payment_intent || pay.paypal_capture_id)),
    history,
  });
});

/**
 * POST /api/admin/bookings/:number/refund 返金を実行（管理者の承認操作）
 * body: { amount:number, reason?:string, markManualDone?:boolean }
 *  - カード(Stripe)/PayPal … 金額を指定してシステムが自動返金（一部返金可）
 *  - 銀行振込/コンビニ/請求書 … 自動返金しない。手動対応の記録のみ（markManualDone で完了記録）
 * すべて refund_log に監査記録を残す。
 */
app.post('/bookings/:number/refund', async (c) => {
  const db = c.env.DB;
  const admin = c.get('admin');
  const g = await getBookingGroupByNumber(db, c.req.param('number'));
  if (!g) return c.json({ error: 'booking not found' }, 404);
  const body = await c.req
    .json<{ amount?: number; reason?: string; markManualDone?: boolean }>()
    .catch(() => ({}) as { amount?: number; reason?: string; markManualDone?: boolean });
  const pay = await getRefundablePaymentForGroup(db, g.id);
  const paidAmount = g.payment_status === 'paid' ? (pay?.amount ?? g.total_amount) : 0;
  const refunded = pay?.refunded_amount ?? 0;
  const max = maxRefundable(g.payment_status, paidAmount, refunded);
  const amount = Math.round(Number(body.amount));
  const v = validateRefundAmount(amount, max);
  if (!v.ok) return c.json({ error: v.error }, 400);

  let stripeType: string | null = null;
  const _pi = pay?.stripe_payment_intent;
  const _sk = c.env.STRIPE_SECRET_KEY;
  if (g.payment_method === 'stripe' && _pi && _sk) {
    stripeType = await retrievePaymentIntentMethodType(_sk, _pi);
  }
  const mode = refundModeFor(g.payment_method, stripeType);
  const now = nowJST();

  // 手動返金（銀行振込・コンビニ・請求書）：実送金は管理者。記録のみ。
  if (mode === 'manual') {
    const status = body.markManualDone ? 'manual_done' : 'manual_pending';
    await recordRefundLog(db, { groupId: g.id, amount, mode: 'manual', status, reason: body.reason ?? null, createdBy: admin?.email ?? null }, now);
    if (body.markManualDone && pay) {
      await addRefundedAmount(db, pay.id, amount);
      // 予約が継続（確定）している返金は、領収書を最終金額で再発行（備考に経緯）
      if (g.status === 'confirmed') {
        try {
          await reissueReceiptForGroup(db, g.id, `${todayJST()} 予約内容変更に伴う返金 ¥${Math.round(amount).toLocaleString('ja-JP')} を反映し、変更後の合計金額で再発行しました。`);
        } catch { /* 再発行失敗は返金処理に影響させない */ }
      }
      try {
        await recordBookingEvent(db, { groupId: g.id, type: 'refund', amount, summary: `返金 ¥${Math.round(amount).toLocaleString('ja-JP')}（銀行振込・手動）`, actor: admin?.email ? 'admin:' + admin.email : 'admin' }, now);
      } catch { /* 履歴記録の失敗は返金処理に影響させない */ }
    }
    return c.json({
      ok: true,
      mode: 'manual',
      status,
      message: body.markManualDone
        ? '手動返金（振込）を記録しました。'
        : 'この予約は銀行振込／コンビニ払いです。お客様に返金先口座を伺い、銀行振込で返金してください（自動返金は行いません）。完了後に「振込済みとして記録」を押してください。',
    });
  }

  // 自動返金（カード/PayPal）
  if (!pay) return c.json({ error: '返金対象の決済が見つかりません' }, 400);
  let refundId: string | undefined;
  if (mode === 'auto_stripe') {
    if (!pay.stripe_payment_intent || !c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Stripeの決済情報が不足しています（手動返金してください）' }, 400);
    const r = await refundPaymentAmount(c.env.STRIPE_SECRET_KEY, pay.stripe_payment_intent, amount);
    if (!r.ok) return c.json({ error: 'Stripe返金に失敗しました：' + (r.error || '') }, 502);
    refundId = r.refundId;
  } else {
    if (!pay.paypal_capture_id) return c.json({ error: 'PayPalの決済情報が不足しています（手動返金してください）' }, 400);
    const r = await refundPaypalCapture(c.env, pay.paypal_capture_id, amount);
    if (!r.ok) return c.json({ error: 'PayPal返金に失敗しました：' + (r.error || '') }, 502);
    refundId = r.refundId;
  }
  await addRefundedAmount(db, pay.id, amount);
  await recordRefundLog(
    db,
    { groupId: g.id, amount, mode: mode === 'auto_stripe' ? 'stripe' : 'paypal', status: 'done', providerRefundId: refundId ?? null, reason: body.reason ?? null, createdBy: admin?.email ?? null },
    now,
  );
  // 予約が継続（確定）している返金は、領収書を最終金額で再発行（備考に経緯）
  if (g.status === 'confirmed') {
    try {
      await reissueReceiptForGroup(db, g.id, `${todayJST()} 予約内容変更に伴う返金 ¥${Math.round(amount).toLocaleString('ja-JP')} を反映し、変更後の合計金額で再発行しました。`);
    } catch { /* 再発行失敗は返金処理に影響させない */ }
  }
  try {
    await recordBookingEvent(db, { groupId: g.id, type: 'refund', amount, summary: `返金 ¥${Math.round(amount).toLocaleString('ja-JP')}（${mode === 'auto_paypal' ? 'PayPal' : 'カード'}・自動）`, actor: admin?.email ? 'admin:' + admin.email : 'admin' }, now);
  } catch { /* 履歴記録の失敗は返金処理に影響させない */ }
  return c.json({ ok: true, mode, status: 'done', refundId, refundedTotal: refunded + amount, message: `¥${amount.toLocaleString()} を返金しました。` });
});

/**
 * POST /api/admin/bookings/:number/additional-charge 追加請求リンクの発行
 * 予約内容変更で料金が上がったときの差額を、Stripe決済リンクで集金する。
 * body: { amount:number, reason?:string }
 * 案A：そのスペースで許可された方法を出す（カード＋コンビニ）。お客様へリンクをメール。
 * 入金は webhook（kind='additional'）で確定し、領収書を最終金額で再発行（Stage4）。
 */
app.post('/bookings/:number/additional-charge', async (c) => {
  const db = c.env.DB;
  const g = await getBookingGroupByNumber(db, c.req.param('number'));
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (g.status !== 'confirmed') return c.json({ error: '確定済みの予約にのみ追加請求できます' }, 400);
  const body = await c.req
    .json<{ amount?: number; reason?: string }>()
    .catch(() => ({}) as { amount?: number; reason?: string });
  const amount = Math.round(Number(body.amount));
  if (!(amount > 0)) return c.json({ error: '追加金額は1円以上を指定してください' }, 400);
  if (!stripeConfigured(c.env)) return c.json({ error: 'Stripeが未設定です' }, 503);

  const space = await getSpaceById(db, g.space_id);
  const prof = g.customer_id ? await getCustomerProfile(db, g.customer_id) : null;
  const email = prof?.email ? String(prof.email) : '';
  const customerName = prof?.contact_name ? String(prof.contact_name) : 'お客様';
  const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;

  // 案A：そのスペースで許可された方法を出す。銀行振込(customer_balance)は単独セッションが
  // 必要なため、この即時リンクでは カード＋コンビニ（スペースが許可していれば）に対応する。
  const konbiniReady = String(c.env.STRIPE_KONBINI_ENABLED ?? '').toLowerCase() === 'true';
  const konbiniOk = konbiniReady && space?.payment_mode === 'card_konbini_bank';
  const payId = crypto.randomUUID();
  try {
    const session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY!, {
      productName: `追加料金 ${g.booking_number}（${space?.name ?? ''}）`,
      amountJpy: amount,
      successUrl: `${origin}/pay-complete.html?type=additional&session={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/pay-complete.html?type=additional&status=cancel&num=${encodeURIComponent(g.booking_number)}`,
      customerEmail: email || undefined,
      clientReferenceId: payId,
      metadata: { kind: 'additional', groupId: g.id, bookingNumber: g.booking_number },
      paymentMethodTypes: konbiniOk ? ['card', 'konbini'] : ['card'],
      konbiniExpiresAfterDays: konbiniOk ? 3 : undefined,
    });
    await createBookingPayment(
      db,
      { id: payId, groupId: g.id, provider: 'stripe', amount, sessionId: session.id, kind: 'additional' },
      nowJST(),
    );
    let emailed = false;
    if (email) {
      const mail = additionalChargeEmail({
        customerName,
        bookingNumber: g.booking_number,
        spaceName: space?.name ?? '',
        amount,
        payUrl: session.url,
        reason: body.reason,
      });
      c.executionCtx.waitUntil(sendEmail(c.env, { to: email, ...mail }));
      emailed = true;
    }
    try {
      const admin = c.get('admin');
      await recordBookingEvent(db, { groupId: g.id, type: 'additional_issued', amount, summary: `追加請求 ¥${Math.round(amount).toLocaleString('ja-JP')} を発行${body.reason ? '（' + body.reason + '）' : ''}`, actor: admin?.email ? 'admin:' + admin.email : 'admin' }, nowJST());
    } catch { /* 履歴記録の失敗は発行に影響させない */ }
    return c.json({ ok: true, url: session.url, emailed, amount });
  } catch (err) {
    return c.json({ error: '追加請求リンクの作成に失敗しました：' + (err as Error).message }, 502);
  }
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
 * GET /api/admin/bookings/:number 予約グループの明細（予約内容変更モーダル用）
 * 現在のオプション選択と、そのスペースで選べるオプション一覧も返す。
 */
app.get('/bookings/:number', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);
  const space = await getSpaceById(db, g.space_id);
  const rows = await getBookingsByGroup(db, g.id);
  const { results: optSel } = await db
    .prepare('SELECT option_id, quantity, subtotal FROM booking_option_selections WHERE group_id = ?')
    .bind(g.id)
    .all<{ option_id: string; quantity: number; subtotal: number }>();
  const spaceOpts = await getSpaceOptions(db, g.space_id);
  const currentOptionsTotal = (optSel ?? []).reduce((s, o) => s + o.subtotal, 0);
  const answers = await getBookingAnswers(db, g.id);
  const ticketPaid = !!(await getTicketUsageForGroup(db, g.id)); // チケット払いか（日時変更で時間数変更不可）#24
  return c.json({
    bookingNumber: g.booking_number,
    status: g.status,
    eventName: g.event_name,
    spaceName: space?.name ?? '',
    spaceId: g.space_id,
    openTime: space?.open_time ?? null,
    closeTime: space?.close_time ?? null,
    totalAmount: g.total_amount,
    spaceFee: g.total_amount - currentOptionsTotal, // スペース料金（オプションを除いた分）
    paymentMethod: g.payment_method,
    invoiceName: g.invoice_name,
    paymentStatus: g.payment_status,
    ticketPaid,
    answers, // 追加質問の回答（#22）
    items: rows.map((r) => ({
      date: r.date,
      startTime: r.start_time,
      endTime: r.end_time,
      isResidence: !!r.is_residence,
    })),
    options: (optSel ?? []).map((o) => ({ optionId: o.option_id, quantity: o.quantity })),
    availableOptions: spaceOpts
      .filter((o) => o.is_active)
      .map((o) => ({
        id: o.id,
        name: o.name,
        type: o.type,
        priceType: o.price_type,
        unitPrice: o.unit_price,
        unitLabel: o.unit_label,
        maxQty: o.max_qty,
        stockTotal: o.stock_total,
      })),
  });
});

/**
 * PUT /api/admin/bookings/:number/payment-status 支払いステータスの手動変更（#42運用）
 * body: { status: 'paid' | 'unpaid' | 'invoice' }
 * 社員・身内利用など、銀行振込で予約だけ確保して入金状態を任意に切り替える運用向け。
 * paid にした場合は領収書を自動発行（冪等）して URL を返す。
 */
app.put('/bookings/:number/payment-status', async (c) => {
  const number = c.req.param('number');
  const b = (await c.req.json().catch(() => ({}))) as { status?: unknown };
  const status = String(b.status ?? '').trim();
  if (!['paid', 'unpaid', 'invoice'].includes(status)) {
    return c.json({ error: '支払いステータスが不正です' }, 400);
  }
  const g = await getBookingGroupByNumber(c.env.DB, number);
  if (!g) return c.json({ error: '予約が見つかりません' }, 404);
  await c.env.DB.prepare('UPDATE booking_groups SET payment_status = ? WHERE id = ?').bind(status, g.id).run();
  let receiptUrl: string | null = null;
  if (status === 'paid') {
    // 入金済みにしたら領収書を発行（既に発行済みならそのURLを返す）
    const r = await createDocumentForGroup(c.env.DB, g.id, 'receipt');
    if (r) receiptUrl = '/api/documents/' + r.token;
    // 入金確認・予約確定メール（お客様＋管理者）#49。失敗しても処理は継続。
    c.executionCtx.waitUntil(notifyPaymentConfirmed(c.env, g.id, receiptUrl).catch(() => {}));
  }
  // カレンダーの支払いステータス表示を更新（#54関連）
  const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  c.executionCtx.waitUntil(syncBookingCalendarEvents(c.env, g.id, origin).catch(() => {}));
  return c.json({ ok: true, paymentStatus: status, receiptUrl });
});

/**
 * POST /api/admin/bookings/:number/reschedule 日時変更（管理者）
 * body: { items: [{date,startTime,endTime,isResidence?}] }
 * 管理者は受付期間（締切/受付開始）の制約を無視できる。休業日・競合は不可。
 */
app.post('/bookings/:number/reschedule', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const body = (await c.req.json().catch(() => ({}))) as {
    items?: Array<{ date: string; startTime: string; endTime: string; isResidence?: boolean }>;
    options?: Array<{ optionId: string; quantity?: number }>;
  };
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

  // オプションの検証・在庫確認（新しい日程の各日で、自グループを除いた在庫を確認）
  const reqOptions = Array.isArray(body.options) ? body.options : undefined;
  let newOptionsTotal = 0;
  const newSelections: Array<{ optionId: string; quantity: number; subtotal: number }> = [];
  const optionLines: Array<{ name: string; quantity: number; subtotal: number }> = []; // 通知メール用
  if (reqOptions && reqOptions.length > 0) {
    const optMap = await getOptionsByIds(db, reqOptions.map((o) => o.optionId));
    const newDatesForStock = [...new Set(body.items.map((i) => i.date))];
    for (const req of reqOptions) {
      const opt = optMap.get(req.optionId);
      if (!opt || !opt.is_active) return c.json({ error: `オプションが見つかりません: ${req.optionId}` }, 400);
      if (!(await isOptionAvailableForSpace(db, space.id, opt.id))) {
        return c.json({ error: `${opt.name} はこのスペースで利用できません` }, 400);
      }
      const norm = normalizeQuantity(
        { id: opt.id, type: opt.type, priceType: opt.price_type, unitPrice: opt.unit_price, maxQty: opt.max_qty, stockTotal: opt.stock_total },
        req.quantity ?? 1,
      );
      if (norm.error) return c.json({ error: `${opt.name}: ${norm.error}` }, 400);
      if (norm.quantity <= 0) continue;
      for (const date of newDatesForStock) {
        const used = await getDailyOptionUsage(db, opt.id, date, g.id); // 自グループ除外
        if (!hasStock(opt.stock_total, used, norm.quantity)) {
          return c.json({ error: `${opt.name} は ${date} の在庫が不足しています（残${Math.max(0, (opt.stock_total ?? 0) - used)}）` }, 409);
        }
      }
      const subtotal = optionSubtotal(opt.price_type, opt.unit_price, norm.quantity);
      newSelections.push({ optionId: opt.id, quantity: norm.quantity, subtotal });
      optionLines.push({ name: opt.name, quantity: norm.quantity, subtotal });
      newOptionsTotal += subtotal;
    }
  }
  // options を省略した場合は既存のオプションを維持（合計はそのまま）
  const optionsProvided = reqOptions !== undefined;
  // オプションが「実際に」変わったかを判定（変更通知メールの「変更点」表示・送信要否に使う）。
  // 未指定＝据え置きなので変更なし。指定時は旧選択（option_id×数量）と比較する。
  let optionsChanged = false;
  if (optionsProvided) {
    const { results: oldSelRows } = await db
      .prepare('SELECT option_id, quantity FROM booking_option_selections WHERE group_id = ?')
      .bind(g.id)
      .all<{ option_id: string; quantity: number }>();
    const oldSig = (oldSelRows ?? []).map((o) => `${o.option_id}:${o.quantity}`).sort().join('|');
    const newSig = newSelections.map((o) => `${o.optionId}:${o.quantity}`).sort().join('|');
    optionsChanged = oldSig !== newSig;
  }
  const curOptRow = await db
    .prepare('SELECT COALESCE(SUM(subtotal),0) AS t FROM booking_option_selections WHERE group_id = ?')
    .bind(g.id)
    .first<{ t: number }>();
  const currentOptionsTotal = curOptRow?.t ?? 0;
  const optionsTotalFinal = optionsProvided ? newOptionsTotal : currentOptionsTotal;

  // 合計＝スペース料金＋オプション料金。
  // 商談中（仮予約）はスペース料金を据え置き（既存のスペース分を維持）。
  // 本予約（代理予約含む）はスペース料金を再計算し、差額を返す。
  const existingSpaceFee = g.total_amount - currentOptionsTotal;

  // チケット払いの予約は、旧消費を戻して新しい日程で再充当する（#24）。
  const ticketUsage = isTentative ? null : await getTicketUsageForGroup(db, g.id);
  let ticketRecalc: { usageId: string; ticketId: string; newRemaining: number; newHours: number; coveredYen: number } | null = null;
  let newSpaceFee: number;
  if (ticketUsage) {
    // チケット予約は「合計の利用時間数」を変更できない（日程・開始時刻の移動のみ）#24
    const oldHours = oldRows.reduce((s, r) => s + r.billable_hours, 0);
    const newHours = newGroup.days.reduce((s, d) => s + d.billableHours, 0);
    if (newHours !== oldHours) {
      return c.json(
        { error: 'チケットでご予約の場合、利用時間（合計時間数）は変更できません。日付・開始時刻の移動のみ可能です。時間数を変えたい場合は、一度キャンセルして取り直してください。', code: 'TICKET_DURATION_FIXED' },
        400,
      );
    }
    const restored = ticketUsage.remainingHours + ticketUsage.oldHours; // 旧消費を一旦戻した残時間
    const cov = coveredAmountForHours(
      newGroup.days.map((d) => ({ billableHours: d.billableHours, price: d.price })),
      restored,
    );
    newSpaceFee = Math.max(0, newGroup.spaceTotal - cov.coveredYen); // チケット充当後の自己負担分
    ticketRecalc = {
      usageId: ticketUsage.usageId,
      ticketId: ticketUsage.ticketId,
      newRemaining: restored - cov.coveredHours,
      newHours: cov.coveredHours,
      coveredYen: cov.coveredYen,
    };
  } else {
    newSpaceFee = isTentative ? existingSpaceFee : newGroup.spaceTotal;
  }
  const newTotal = newSpaceFee + optionsTotalFinal;
  const adjustment = isTentative ? null : computeAdjustment(g.total_amount, newTotal);

  const newBookingIds = body.items.map(() => crypto.randomUUID());
  // チケット再計算の文（外部キー制約回避のため2段構成で組み立てる）
  const ticketStmts = ticketRecalc
    ? buildTicketRescheduleStmts(db, {
        usageId: ticketRecalc.usageId,
        ticketId: ticketRecalc.ticketId,
        newRemaining: ticketRecalc.newRemaining,
        newHours: ticketRecalc.newHours,
        spaceTotal: newGroup.spaceTotal,
        coveredYen: ticketRecalc.coveredYen,
        newFirstBookingId: newBookingIds[0],
        now: nowJST(),
      })
    : null;
  const stmts: D1PreparedStatement[] = [];
  // 旧 ticket_usage を先に削除してから旧 bookings を削除（FK 回避）
  if (ticketStmts) stmts.push(ticketStmts.clearOldUsage);
  stmts.push(db.prepare('DELETE FROM bookings WHERE group_id = ?').bind(g.id));
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
  stmts.push(db.prepare('UPDATE booking_groups SET total_amount = ?, reschedule_count = reschedule_count + 1 WHERE id = ?').bind(newTotal, g.id));
  // チケット払いの予約：新 bookings 挿入後に残時間更新＋新 ticket_usage を挿入
  if (ticketStmts) stmts.push(...ticketStmts.applyNew);
  // オプションが指定されていれば置き換え（未指定なら既存を維持）
  if (optionsProvided) {
    stmts.push(db.prepare('DELETE FROM booking_option_selections WHERE group_id = ?').bind(g.id));
    for (const sel of newSelections) {
      stmts.push(
        db
          .prepare('INSERT INTO booking_option_selections (id, group_id, option_id, quantity, subtotal) VALUES (?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), g.id, sel.optionId, sel.quantity, sel.subtotal),
      );
    }
  }
  await db.batch(stmts);

  const cust = g.customer_id ? await getCustomerProfile(db, g.customer_id) : null;
  const custName = cust?.contact_name ? String(cust.contact_name) : (g.event_name || 'お客様');

  // Googleカレンダー同期：旧イベント削除→新日時でリッチ内容作成（#54関連）
  let calendarWarning: string | null = null;
  if (space.google_calendar_id) {
    await deleteBookingFromCalendar(c.env, space.google_calendar_id, oldRows.map((r) => r.google_event_id));
    const rsOrigin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
    const res = await syncBookingCalendarEvents(c.env, g.id, rsOrigin);
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
    oldTotal: g.total_amount,
    status: keepStatus as 'confirmed' | 'tentative',
    showAmount: !isTentative,
    // オプションを編集した場合のみメールに反映（未指定なら省略）
    options: optionsProvided ? optionLines : undefined,
    // 「変更点」に『オプション』を出すのは実際に変わったときだけ（据え置き保存で誤表示しない）
    optionsChanged,
  };
  // 実際に何か変わったか（日時／オプション／金額）。何も変わっていない保存では
  // 紛らわしい「変更しました」メールを送らない。
  const dayKey = (d: { date: string; startTime: string; endTime: string }) => `${d.date} ${d.startTime}-${d.endTime}`;
  const daysChanged =
    oldDays.length !== newDays.length ||
    oldDays.map(dayKey).sort().join('|') !== newDays.map(dayKey).sort().join('|');
  const amountChanged = !!adjustment && adjustment.type !== 'zero';
  const anyChange = daysChanged || optionsChanged || amountChanged;
  const custEmail = cust?.email ? String(cust.email) : '';
  if (anyChange && custEmail) {
    c.executionCtx.waitUntil(sendEmail(c.env, { to: custEmail, ...rescheduleEmail(mailData) }));
  }
  const rsAdmins = await adminRecipients(c.env, g.space_id);
  if (anyChange && rsAdmins.length) {
    const adminMail = adminRescheduleEmail({ ...mailData, customerEmail: custEmail || undefined, customerPhone: cust?.phone ? String(cust.phone) : undefined });
    c.executionCtx.waitUntil(sendEmail(c.env, { to: rsAdmins, ...adminMail }));
    // 料金変更（差額）が出た本予約のみ、返金/追加請求の対応要アラートを発信（#62/#64）
    if (adjustment && adjustment.type !== 'zero') {
      const alert = adminPaymentActionAlertEmail({
        kind: 'reschedule',
        action: adjustment.type === 'surcharge' ? 'surcharge' : 'refund',
        amount: adjustment.amount,
        bookingNumber: number,
        spaceName: space.name,
        customerName: custName,
        customerEmail: custEmail || undefined,
        customerPhone: cust?.phone ? String(cust.phone) : undefined,
        paymentMethod: g.payment_method,
        paymentStatus: g.payment_status,
        oldTotal: g.total_amount,
        newTotal,
        adminUrl: `${c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin}/admin.html?booking=${encodeURIComponent(number)}`,
      });
      c.executionCtx.waitUntil(sendEmail(c.env, { to: rsAdmins, ...alert }));
    }
  }

  // 変更履歴に記録（金額が変わった場合はその旨も）#93
  try {
    const adminR = c.get('admin');
    const changed = g.total_amount !== newTotal;
    const summary = changed
      ? `日時・内容を変更（合計 ¥${Math.round(g.total_amount).toLocaleString('ja-JP')}→¥${Math.round(newTotal).toLocaleString('ja-JP')}）`
      : '日時・内容を変更';
    await recordBookingEvent(db, { groupId: g.id, type: 'reschedule', amount: changed ? newTotal : null, summary, actor: adminR?.email ? 'admin:' + adminR.email : 'admin' }, nowJST());
  } catch { /* 履歴記録の失敗は変更処理に影響させない */ }

  return c.json({ bookingNumber: number, newTotal, adjustment, calendarWarning });
});

// ---------------------------------------------------------------------------
// 予約変更リクエスト（マイページ発／承認制）#54
// ---------------------------------------------------------------------------

/** GET /api/admin/change-requests?status=pending 変更リクエスト一覧 */
app.get('/change-requests', async (c) => {
  const status = c.req.query('status') ?? undefined; // 省略で全件
  const rows = await listChangeRequests(c.env.DB, status);
  const requests = rows.map((r) => ({
    id: r.id,
    bookingNumber: r.booking_number,
    type: r.type,
    message: r.message,
    status: r.status,
    resolution: r.resolution,
    adminNote: r.admin_note,
    createdAt: r.created_at,
    handledAt: r.handled_at,
    spaceName: r.space_name ?? '',
    eventName: r.event_name ?? '',
    groupStatus: r.group_status ?? '',
    customerName: r.contact_name ?? '',
    customerEmail: r.customer_email ?? '',
    customerPhone: r.customer_phone ?? '',
    proposedItems: r.proposed_items ? safeParseItems(r.proposed_items) : null,
  }));
  return c.json({ requests });
});

function safeParseItems(json: string): Array<{ date: string; startTime: string; endTime: string }> | null {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/admin/change-requests/:id/resolve 変更リクエストの処理を記録
 * body: { resolution: 'approved'|'rejected'|'handled', adminNote? }
 * ※実際の予約変更（reschedule等）はフロントから既存APIを呼んで適用し、
 *   その成否に応じて本APIで対応結果を記録する。rejected の場合は却下メールを送る。
 */
app.post('/change-requests/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { resolution?: string; adminNote?: string };
  const validRes = ['approved', 'rejected', 'handled'];
  if (!body.resolution || !validRes.includes(body.resolution)) {
    return c.json({ error: 'resolution(approved/rejected/handled) は必須です' }, 400);
  }
  const req = await getChangeRequestById(c.env.DB, id);
  if (!req) return c.json({ error: 'リクエストが見つかりません' }, 404);
  if (req.status === 'handled') return c.json({ error: 'このリクエストは処理済みです' }, 409);

  const resolution = body.resolution as 'approved' | 'rejected' | 'handled';
  const adminNote = (body.adminNote ?? '').trim() || null;
  const admin = c.get('admin');
  await resolveChangeRequest(c.env.DB, id, { resolution, adminNote, handledBy: admin?.email ?? null, now: nowJST() });

  // 却下時はお客様へ通知（承認時の変更確定メールは reschedule 側で送信済み）
  if (resolution === 'rejected' && req.customer_email) {
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        to: req.customer_email,
        ...changeRequestRejectedEmail({
          customerName: req.contact_name || 'お客様',
          bookingNumber: req.booking_number,
          spaceName: req.space_name || '',
          adminNote: adminNote ?? undefined,
        }),
      }),
    );
  }
  return c.json({ ok: true, id, resolution });
});

// ---------------------------------------------------------------------------
// 見学申込（#81）
// ---------------------------------------------------------------------------

/** GET /api/admin/viewing-requests?status= 見学申込一覧 */
app.get('/viewing-requests', async (c) => {
  const status = c.req.query('status') ?? undefined;
  const rows = await listViewingRequests(c.env.DB, status);
  const requests = rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    customerName: r.customer_name,
    email: r.email,
    phone: r.phone,
    orgName: r.org_name ?? '',
    purpose: r.purpose,
    bookingStatus: r.booking_status,
    spaceIds: (r.space_ids ?? '').split(',').filter(Boolean),
    spaceNames: r.space_names ?? '',
    first: r.first_date ? { date: r.first_date, start: r.first_start } : null,
    second: r.second_date ? { date: r.second_date, start: r.second_start } : null,
    desiredPeriod: r.desired_period ?? '',
    prefDaytype: r.pref_daytype ?? '',
    prefTimeband: r.pref_timeband ?? '',
    note: r.note ?? '',
    status: r.status,
    confirmed: r.confirmed_date ? { date: r.confirmed_date, start: r.confirmed_start, end: r.confirmed_end } : null,
    staffNote: r.staff_note ?? '',
    customerId: r.customer_id ?? '',
    isMember: !!r.customer_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? '',
  }));
  return c.json({ requests });
});

const VIEWING_TIME_RE = /^\d{1,2}:\d{2}$/;
const VIEWING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 見学の確定/提案（日時を指定してメール送信）。action=confirm|propose */
async function handleViewingSchedule(c: Context<AppBindings>, action: 'confirm' | 'propose') {
  const id = c.req.param('id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as { date?: string; start?: string; staffNote?: string };
  const date = String(body.date ?? '').trim();
  const start = String(body.start ?? '').trim();
  const staffNote = (body.staffNote ?? '').trim() || null;
  if (!VIEWING_DATE_RE.test(date) || !VIEWING_TIME_RE.test(start)) {
    return c.json({ error: '日付(YYYY-MM-DD)・開始時刻(HH:MM)を指定してください' }, 400);
  }
  const req = await getViewingRequest(c.env.DB, id);
  if (!req) return c.json({ error: '見学申込が見つかりません' }, 404);
  const startMin = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5)) + VIEWING_DURATION_MIN;
  const end = `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`;
  const status = action === 'confirm' ? 'confirmed' : 'proposed';
  await updateViewingRequest(c.env.DB, id, { status, confirmedDate: date, confirmedStart: start, confirmedEnd: end, staffNote, now: nowJST() });
  const mailData = { customerName: req.customer_name, spaceNames: req.space_names ?? '', date, start, end, staffNote: staffNote ?? undefined };
  const mail = action === 'confirm' ? viewingConfirmedEmail(mailData) : viewingProposedEmail(mailData);
  c.executionCtx.waitUntil(sendEmail(c.env, { to: req.email, ...mail }));
  return c.json({ ok: true, id, status, date, start, end });
}

/** POST /api/admin/viewing-requests/:id/confirm 確定（お客様へ確定メール） */
app.post('/viewing-requests/:id/confirm', (c) => handleViewingSchedule(c, 'confirm'));

/** POST /api/admin/viewing-requests/:id/propose 候補提案（お客様へ提案メール） */
app.post('/viewing-requests/:id/propose', (c) => handleViewingSchedule(c, 'propose'));

/** POST /api/admin/viewing-requests/:id/decline お断り／再調整のご案内 */
app.post('/viewing-requests/:id/decline', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { staffNote?: string };
  const staffNote = (body.staffNote ?? '').trim() || null;
  const req = await getViewingRequest(c.env.DB, id);
  if (!req) return c.json({ error: '見学申込が見つかりません' }, 404);
  await updateViewingRequest(c.env.DB, id, { status: 'declined', confirmedDate: null, confirmedStart: null, confirmedEnd: null, staffNote, now: nowJST() });
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: req.email,
      ...viewingDeclinedEmail({ customerName: req.customer_name, spaceNames: req.space_names ?? '', staffNote: staffNote ?? undefined }),
    }),
  );
  return c.json({ ok: true, id, status: 'declined' });
});

/** POST /api/admin/viewing-requests/:id/cancel 申込のクローズ（メールなし） */
app.post('/viewing-requests/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const req = await getViewingRequest(c.env.DB, id);
  if (!req) return c.json({ error: '見学申込が見つかりません' }, 404);
  await updateViewingRequest(c.env.DB, id, { status: 'cancelled', confirmedDate: req.confirmed_date, confirmedStart: req.confirmed_start, confirmedEnd: req.confirmed_end, staffNote: null, now: nowJST() });
  return c.json({ ok: true, id, status: 'cancelled' });
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
    // 閲覧可能期間（#77）。予約可能期間を下回らないよう下限クランプ。既定180。
    viewHorizonDays: Math.max(
      Number(body.bookingHorizonDays ?? 180),
      Number.isFinite(Number(body.viewHorizonDays)) ? Number(body.viewHorizonDays) : 180,
    ),
    bookingDeadlineDays: num(body.bookingDeadlineDays),
    blockName: body.blockName ? String(body.blockName) : null,
    sortOrder: Number(body.sortOrder ?? 0),
    isActive: body.isActive !== false,
    // 支払いモード（#67）。未指定は card_bank（②）を既定に。
    paymentMode:
      body.paymentMode === 'card_only' || body.paymentMode === 'card_konbini_bank'
        ? body.paymentMode
        : 'card_bank',
    // 請求書払い（手動・自社口座／Stripe非経由）の受付可否（#88関連）
    allowManualInvoice: !!body.allowManualInvoice,
    // スペース別の通知先メール（#72）。空欄なら本部のみに通知。
    notifyEmail: body.notifyEmail ? String(body.notifyEmail).trim() : null,
    // 空き状況ページ用メタ（#74）
    area: body.area ? String(body.area).trim() : null,
    useCategory: body.useCategory ? String(body.useCategory).trim() : null,
    roomGroup: body.roomGroup ? String(body.roomGroup).trim() : null,
    sameDayCutoffHours: Number.isFinite(Number(body.sameDayCutoffHours)) ? Math.max(0, Math.floor(Number(body.sameDayCutoffHours))) : 1,
    sameDayPriority: Number.isFinite(Number(body.sameDayPriority)) ? Math.floor(Number(body.sameDayPriority)) : 100,
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

// スペース別キャンセルポリシーのプリセット（#99）。
// 'piano'（ピアノ練習室特別）= 8日以上前:無料 / 2〜7日前:50% / 前日・当日:100%。
// 'standard' = スペース個別を持たず共通ポリシーに従う。
const PIANO_CANCEL_TIERS = [
  { daysBefore: 7, chargePct: 50, cutoffTime: null, sortOrder: 1 },
  { daysBefore: 1, chargePct: 100, cutoffTime: null, sortOrder: 2 },
];

/** GET /api/admin/spaces/:id/cancel-policy 現在のプリセット（standard/piano） */
app.get('/spaces/:id/cancel-policy', async (c) => {
  const rows = await getSpaceCancelPolicyRows(c.env.DB, c.req.param('id'));
  return c.json({ preset: rows.length ? 'piano' : 'standard' });
});

/** PUT /api/admin/spaces/:id/cancel-policy {preset:'standard'|'piano'} プリセットを設定 */
app.put('/spaces/:id/cancel-policy', requireRole('owner', 'manager'), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { preset?: string };
  const preset = body.preset === 'piano' ? 'piano' : 'standard';
  await setSpaceCancelPolicyTiers(c.env.DB, c.req.param('id'), preset === 'piano' ? PIANO_CANCEL_TIERS : []);
  return c.json({ ok: true, preset });
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
  const [points, coupons, tickets] = await Promise.all([
    getPointBalanceAndLog(c.env.DB, id),
    getMemberCoupons(c.env.DB, id),
    getMemberTickets(c.env.DB, id, todayJST()),
  ]);
  return c.json({ profile, points, coupons, tickets });
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

/** POST /api/admin/customers/:id/tickets チケット発行（owner/manager）#24
 * productId を渡すと販売中のチケット商品から発行（名称・時間・対象スペース・有効日数を継承）。
 * 手動発行の場合は name/totalHours/validUntil/spaceIds を直接指定。
 */
app.post('/customers/:id/tickets', requireRole('owner', 'manager'), async (c) => {
  const customerId = c.req.param('id');
  const profile = await getCustomerProfile(c.env.DB, customerId);
  if (!profile) return c.json({ error: 'customer not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const b = body as Record<string, unknown>;
  const validFrom = String(b.validFrom ?? '').trim() || todayJST();
  const productId = b.productId ? String(b.productId) : null;

  let name: string;
  let totalHours: number;
  let validUntil: string;
  let spaceIds: string[];

  if (productId) {
    const product = await getTicketProduct(c.env.DB, productId) as
      | { name: string; total_hours: number; validity_days: number; space_ids: string[] }
      | null;
    if (!product) return c.json({ error: 'チケット商品が見つかりません' }, 404);
    name = product.name;
    totalHours = product.total_hours;
    spaceIds = product.space_ids;
    // 有効終了 = 発行日 + 有効日数（未指定時）。明示指定があれば優先。
    validUntil = String(b.validUntil ?? '').trim() || addDaysJST(validFrom, product.validity_days);
  } else {
    name = String(b.name ?? '').trim();
    totalHours = Number(b.totalHours ?? 0);
    validUntil = String(b.validUntil ?? '').trim();
    spaceIds = Array.isArray(b.spaceIds) ? (b.spaceIds as unknown[]).map(String) : [];
  }

  if (!name) return c.json({ error: 'チケット名は必須です' }, 400);
  if (!Number.isInteger(totalHours) || totalHours <= 0) return c.json({ error: '時間数は1以上の整数で入力してください' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) return c.json({ error: '有効開始日は YYYY-MM-DD で入力してください' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) return c.json({ error: '有効終了日は YYYY-MM-DD で入力してください' }, 400);
  if (validUntil < validFrom) return c.json({ error: '有効終了日は開始日以降にしてください' }, 400);
  const id = await issueTicket(
    c.env.DB,
    { customerId, name, totalHours, validFrom, validUntil, spaceIds, productId },
    nowJST(),
  );
  return c.json({ id }, 201);
});

/** PATCH /api/admin/tickets/:id 発行済みチケットの枚数(時間)・期限・状態を変更（owner/manager）#24 */
app.patch('/tickets/:id', requireRole('owner', 'manager'), async (c) => {
  const ticketId = c.req.param('id');
  const existing = await getIssuedTicket(c.env.DB, ticketId) as { id: string; total_hours: number } | null;
  if (!existing) return c.json({ error: 'ticket not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const b = body as Record<string, unknown>;
  const patch: { totalHours?: number; remainingHours?: number; validUntil?: string; status?: string } = {};
  if (b.totalHours != null && b.totalHours !== '') {
    const v = Number(b.totalHours);
    if (!Number.isInteger(v) || v <= 0) return c.json({ error: '総時間は1以上の整数で入力してください' }, 400);
    patch.totalHours = v;
  }
  if (b.remainingHours != null && b.remainingHours !== '') {
    const v = Number(b.remainingHours);
    if (!Number.isInteger(v) || v < 0) return c.json({ error: '残時間は0以上の整数で入力してください' }, 400);
    patch.remainingHours = v;
  }
  if (b.validUntil != null && b.validUntil !== '') {
    const v = String(b.validUntil);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return c.json({ error: '有効終了日は YYYY-MM-DD で入力してください' }, 400);
    patch.validUntil = v;
  }
  if (b.status != null && b.status !== '') {
    const v = String(b.status);
    if (!['active', 'exhausted', 'expired'].includes(v)) return c.json({ error: '状態が不正です' }, 400);
    patch.status = v;
  }
  // 残時間が総時間を超えないように整合
  const finalTotal = patch.totalHours ?? existing.total_hours;
  if (patch.remainingHours != null && patch.remainingHours > finalTotal) {
    return c.json({ error: '残時間は総時間以下にしてください' }, 400);
  }
  await updateIssuedTicket(c.env.DB, ticketId, patch);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// チケット商品マスタ（販売中のチケット）#24 ※owner / manager
// ---------------------------------------------------------------------------
function parseTicketProductInput(b: Record<string, unknown>): { input?: TicketProductInput; spaceIds?: string[]; error?: string } {
  const name = String(b.name ?? '').trim();
  if (!name) return { error: 'チケット名は必須です' };
  const totalHours = Number(b.totalHours ?? 0);
  if (!Number.isInteger(totalHours) || totalHours <= 0) return { error: '利用可能時間は1以上の整数で入力してください' };
  const price = Number(b.price ?? 0);
  if (!Number.isInteger(price) || price < 0) return { error: '販売料金は0以上の整数で入力してください' };
  const validityDays = Number(b.validityDays ?? 0);
  if (!Number.isInteger(validityDays) || validityDays <= 0) return { error: '有効日数は1以上の整数で入力してください' };
  const spaceIds = Array.isArray(b.spaceIds) ? (b.spaceIds as unknown[]).map(String) : [];
  if (spaceIds.length === 0) return { error: '対象スペースを1つ以上選んでください' };
  return {
    input: { name, totalHours, price, validityDays, isActive: b.isActive !== false && b.isActive !== 0, sortOrder: Number(b.sortOrder ?? 0) || 0 },
    spaceIds,
  };
}

app.get('/ticket-products', async (c) => {
  const products = await getTicketProducts(c.env.DB);
  return c.json({ products });
});

app.post('/ticket-products', requireRole('owner', 'manager'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { input, spaceIds, error } = parseTicketProductInput(body as Record<string, unknown>);
  if (error) return c.json({ error }, 400);
  const id = await insertTicketProduct(c.env.DB, input!, spaceIds!);
  return c.json({ id }, 201);
});

app.put('/ticket-products/:id', requireRole('owner', 'manager'), async (c) => {
  const id = c.req.param('id');
  const existing = await getTicketProduct(c.env.DB, id);
  if (!existing) return c.json({ error: 'ticket product not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const { input, spaceIds, error } = parseTicketProductInput(body as Record<string, unknown>);
  if (error) return c.json({ error }, 400);
  await updateTicketProduct(c.env.DB, id, input!, spaceIds!);
  return c.json({ ok: true });
});

app.delete('/ticket-products/:id', requireRole('owner', 'manager'), async (c) => {
  const id = c.req.param('id');
  const existing = await getTicketProduct(c.env.DB, id);
  if (!existing) return c.json({ error: 'ticket product not found' }, 404);
  const { deleted } = await deleteTicketProduct(c.env.DB, id);
  return c.json({ ok: true, deleted });
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

/** POST /api/admin/customers/:id/block ブラックリスト設定（owner/manager）#69
 *  body:{ blocked:boolean, reason?:string }。blocked=true でこの顧客からの予約を拒否。
 *  メール／電話のどちらか一致でも予約は拒否される（予約API側の isBookingBlocked）。 */
app.post('/customers/:id/block', requireRole('owner', 'manager'), async (c) => {
  const id = c.req.param('id');
  const profile = await getCustomerProfile(c.env.DB, id);
  if (!profile) return c.json({ error: 'customer not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const blocked = body.blocked === true;
  const reason = body.reason ? String(body.reason).trim() : null;
  const r = await setCustomerBlocked(c.env.DB, id, blocked, reason, c.get('admin').id, nowJST());
  if (!r.ok) return c.json({ error: '更新に失敗しました' }, 500);
  return c.json({ blocked });
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

/**
 * キャンペーンが有効な季節料金（割増）期間と重複していないか確認する。
 * 季節料金が優先のため、重複するキャンペーンは登録できない。
 */
async function checkCampaignSeasonalConflict(db: D1Database, input: CampaignInput): Promise<string | null> {
  const seasonals = await getSeasonalAll(db);
  const periods: SeasonalPeriod[] = seasonals.map((s) => ({
    name: s.name,
    startDate: s.start_date,
    endDate: s.end_date,
    spaceIds: s.space_ids,
    isActive: !!s.is_active,
  }));
  const conflict = seasonalCampaignConflict(periods, { startDate: input.startDate, endDate: input.endDate, spaceId: input.spaceId });
  if (conflict) {
    return `この期間・スペースには季節料金（割増）「${conflict.name}」（${conflict.startDate}〜${conflict.endDate}）が設定されています。季節料金が優先のため、重複するキャンペーン（割引）は登録できません。期間・対象スペースを見直してください。`;
  }
  return null;
}

/** POST /api/admin/campaigns キャンペーンを追加 */
app.post('/campaigns', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { input, error } = parseCampaignInput(b);
  if (error || !input) return c.json({ error: error ?? 'invalid input' }, 400);
  const conflict = await checkCampaignSeasonalConflict(c.env.DB, input);
  if (conflict) return c.json({ error: conflict }, 409);
  const id = await insertCampaign(c.env.DB, input);
  return c.json({ id }, 201);
});

/** PUT /api/admin/campaigns/:id キャンペーンを更新 */
app.put('/campaigns/:id', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { input, error } = parseCampaignInput(b);
  if (error || !input) return c.json({ error: error ?? 'invalid input' }, 400);
  const conflict = await checkCampaignSeasonalConflict(c.env.DB, input);
  if (conflict) return c.json({ error: conflict }, 409);
  await updateCampaign(c.env.DB, c.req.param('id'), input);
  return c.json({ ok: true });
});

/** DELETE /api/admin/campaigns/:id キャンペーンを削除 */
app.delete('/campaigns/:id', requireRole('owner', 'manager'), async (c) => {
  await deleteCampaign(c.env.DB, c.req.param('id'));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// サイト設定（お問い合わせURL 等）
// ---------------------------------------------------------------------------

/** GET /api/admin/settings 主要なサイト設定を返す */
app.get('/settings', async (c) => {
  const s = await getSystemSettings(c.env.DB);
  return c.json({
    contactUrl: s.get('contact_url') ?? '',
    pointRate: Number(s.get('point_rate') ?? '1'), // ポイント還元率(%)（#70）
    issuer: {
      name: s.get('issuer_name') ?? '',
      zip: s.get('issuer_zip') ?? '',
      address: s.get('issuer_address') ?? '',
      tel: s.get('issuer_tel') ?? '',
      email: s.get('issuer_email') ?? '',
      invoiceRegNo: s.get('issuer_invoice_reg_no') ?? '',
      bankInfo: s.get('issuer_bank_info') ?? '',
      note: s.get('issuer_note') ?? '',
    },
  });
});

/** PUT /api/admin/settings/issuer 事業者情報（請求書・領収書の発行元）を更新（#41） */
app.put('/settings/issuer', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown) => String(v ?? '').trim();
  const map: Record<string, string> = {
    issuer_name: str(b.name),
    issuer_zip: str(b.zip),
    issuer_address: str(b.address),
    issuer_tel: str(b.tel),
    issuer_email: str(b.email),
    issuer_invoice_reg_no: str(b.invoiceRegNo),
    issuer_bank_info: str(b.bankInfo),
    issuer_note: str(b.note),
  };
  for (const [k, v] of Object.entries(map)) await setSystemSetting(c.env.DB, k, v);
  return c.json({ ok: true });
});

/** PUT /api/admin/settings/point-rate ポイント還元率(%)を更新（#70） */
app.put('/settings/point-rate', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { rate?: unknown };
  const rate = Number(b.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    return c.json({ error: '還元率は0〜100の数値で入力してください' }, 400);
  }
  // 小数第1位まで許容（例 1.5%）。文字列で保存。
  await setSystemSetting(c.env.DB, 'point_rate', String(Math.round(rate * 10) / 10));
  return c.json({ ok: true, rate: Math.round(rate * 10) / 10 });
});

/**
 * GET /api/admin/export/:type?from=&to=&spaceId=  データのExcel(.xlsx)書き出し（#71）
 * type: bookings（予約一覧）/ customers（顧客一覧）/ sales（売上集計・月×スペース）
 * 期間（from/to）・スペース（spaceId）で絞り込み。owner/manager のみ。
 */
app.get('/export/:type', requireRole('owner', 'manager'), async (c) => {
  const type = c.req.param('type');
  const f = {
    from: c.req.query('from') || undefined,
    to: c.req.query('to') || undefined,
    spaceId: c.req.query('spaceId') || undefined,
  };
  const PAY: Record<string, string> = { stripe: 'クレジットカード', paypal: 'PayPal', bank_transfer: '銀行振込（Stripe収納代行）', invoice: '請求書払い' };
  const PS: Record<string, string> = { paid: '入金済み', unpaid: '未入金', invoice: '請求書', refunded: '返金済み' };
  const ST: Record<string, string> = { confirmed: '確定', tentative: '商談中', cancelled: 'キャンセル' };
  const yen = (v: unknown) => (v == null ? 0 : Number(v));
  const str = (v: unknown) => (v == null ? '' : String(v));

  let sheet: Sheet;
  let base: string;
  if (type === 'bookings') {
    const rows = await getBookingsForExport(c.env.DB, f);
    const header = ['予約番号', '利用日', '開始', '終了', 'スペース', 'お客様名', '会社名', 'メール', '電話', 'イベント名', '利用目的', '人数', '日別料金', '予約合計(税込)', '支払方法', '入金状況', '状態', '受付経路', '受付日時'];
    const data = rows.map((r) => [
      str(r.booking_number), str(r.date), str(r.start_time), str(r.end_time), str(r.space_name),
      str(r.contact_name), str(r.company_name), str(r.email), str(r.phone), str(r.event_name),
      str(r.purpose), r.headcount == null ? '' : Number(r.headcount), yen(r.price), yen(r.total_amount),
      PAY[str(r.payment_method)] || str(r.payment_method), PS[str(r.payment_status)] || str(r.payment_status),
      ST[str(r.status)] || str(r.status), str(r.source), str(r.created_at),
    ]);
    sheet = { name: '予約一覧', rows: [header, ...data] };
    base = 'bookings';
  } else if (type === 'customers') {
    const rows = await getCustomersForExport(c.env.DB, f);
    const header = ['お客様名', '会社名', 'メール', '電話', '郵便番号', '住所', '区分', 'ポイント残高', 'ブラックリスト', '登録日', '最終ログイン'];
    const data = rows.map((r) => [
      str(r.contact_name), str(r.company_name), str(r.email), str(r.phone), str(r.postal_code), str(r.address),
      Number(r.is_registered) ? '会員' : 'ゲスト', yen(r.point_balance), Number(r.is_blocked) ? '対象' : '',
      str(r.created_at), str(r.last_login_at),
    ]);
    sheet = { name: '顧客一覧', rows: [header, ...data] };
    base = 'customers';
  } else if (type === 'sales') {
    const rows = await getSalesSummaryForExport(c.env.DB, f);
    const header = ['年月', 'スペース', '件数', '売上合計(税込)'];
    const data = rows.map((r) => [str(r.ym), str(r.space_name), Number(r.cnt), yen(r.sales)]);
    const total = rows.reduce((s, r) => s + yen(r.sales), 0);
    const count = rows.reduce((s, r) => s + Number(r.cnt), 0);
    sheet = { name: '売上集計', rows: [header, ...data, [], ['合計', '', count, total]] };
    base = 'sales';
  } else {
    return c.json({ error: 'unknown export type' }, 400);
  }

  const bytes = buildXlsx([sheet]);
  const filename = `${base}_${todayYmdJST()}.xlsx`;
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Filename': filename,
      'Access-Control-Expose-Headers': 'X-Filename, Content-Disposition',
    },
  });
});

/** GET /api/admin/documents 発行済み書類の一覧（#41） */
app.get('/documents', requireRole('owner', 'manager'), async (c) => {
  const rows = await listDocumentsForAdmin(c.env.DB);
  return c.json({ documents: rows });
});

/**
 * POST /api/admin/documents/issue-receipt  body:{ bookingNumber }
 * 請求書払い（銀行振込）の入金確認後、管理者が領収書を発行する（#41・冪等）。
 */
app.post('/documents/issue-receipt', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { bookingNumber?: unknown };
  const number = String(b.bookingNumber ?? '').trim();
  if (!number) return c.json({ error: '予約番号は必須です' }, 400);
  const g = await getBookingGroupByNumber(c.env.DB, number);
  if (!g) return c.json({ error: '予約が見つかりません' }, 404);
  const r = await createDocumentForGroup(c.env.DB, g.id, 'receipt');
  if (!r) return c.json({ error: '領収書の発行に失敗しました' }, 500);
  // 領収書発行＝入金確認済み。未入金アラートの対象から外すため payment_status を paid にする。
  await c.env.DB.prepare("UPDATE booking_groups SET payment_status = 'paid' WHERE id = ?").bind(g.id).run();
  return c.json({ ok: true, url: '/api/documents/' + r.token, created: r.created });
});

/** PUT /api/admin/settings/contact-url お問い合わせURLを更新 */
app.put('/settings/contact-url', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { url?: unknown };
  const url = String(b.url ?? '').trim();
  if (url && !/^https?:\/\/.+/i.test(url)) {
    return c.json({ error: 'URLは http:// または https:// で始まる形式で入力してください' }, 400);
  }
  await setSystemSetting(c.env.DB, 'contact_url', url);
  return c.json({ ok: true, contactUrl: url });
});

// ---------------------------------------------------------------------------
// スペース別の追加質問（#22）
// ---------------------------------------------------------------------------

function parseSpaceQuestionInput(b: Record<string, unknown>): { input?: SpaceQuestionInput; error?: string } {
  const spaceId = String(b.spaceId ?? '').trim();
  const label = String(b.label ?? '').trim();
  const inputType = b.inputType === 'select' ? 'select' : 'text';
  const required = !!b.required;
  const isActive = b.isActive === undefined ? true : !!b.isActive;
  const sortOrder = Number(b.sortOrder ?? 0) || 0;
  if (!spaceId) return { error: 'スペースは必須です' };
  if (!label) return { error: '質問文は必須です' };
  let options: string[] | null = null;
  if (inputType === 'select') {
    const arr = Array.isArray(b.options) ? (b.options as unknown[]).map((s) => String(s).trim()).filter(Boolean) : [];
    if (arr.length === 0) return { error: '選択式の場合は選択肢を1つ以上入力してください' };
    options = arr;
  }
  return { input: { spaceId, label, inputType, options, required, sortOrder, isActive } };
}

/** GET /api/admin/space-questions?spaceId= スペースの追加質問一覧（無効含む） */
app.get('/space-questions', async (c) => {
  const spaceId = c.req.query('spaceId');
  if (!spaceId) return c.json({ error: 'spaceId は必須です' }, 400);
  const questions = await getSpaceQuestionsAdmin(c.env.DB, spaceId);
  return c.json({
    questions: questions.map((q) => ({
      id: q.id,
      spaceId: q.space_id,
      label: q.label,
      inputType: q.input_type,
      options: q.options ? JSON.parse(q.options) : null,
      required: !!q.required,
      sortOrder: q.sort_order,
      isActive: !!q.is_active,
    })),
  });
});

/** POST /api/admin/space-questions 追加質問を作成 */
app.post('/space-questions', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { input, error } = parseSpaceQuestionInput(b);
  if (error || !input) return c.json({ error: error ?? 'invalid input' }, 400);
  const id = await insertSpaceQuestion(c.env.DB, input);
  return c.json({ id }, 201);
});

/** PUT /api/admin/space-questions/:id 追加質問を更新 */
app.put('/space-questions/:id', requireRole('owner', 'manager'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { input, error } = parseSpaceQuestionInput(b);
  if (error || !input) return c.json({ error: error ?? 'invalid input' }, 400);
  await updateSpaceQuestion(c.env.DB, c.req.param('id'), input);
  return c.json({ ok: true });
});

/** DELETE /api/admin/space-questions/:id 追加質問を削除 */
app.delete('/space-questions/:id', requireRole('owner', 'manager'), async (c) => {
  await deleteSpaceQuestion(c.env.DB, c.req.param('id'));
  return c.json({ ok: true });
});

export default app;
