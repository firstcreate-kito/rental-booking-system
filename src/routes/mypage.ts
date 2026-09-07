import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { requireAuth } from '../middleware/auth';
import {
  getCustomerProfile,
  updateCustomerProfile,
  updateCustomerPassword,
  getCustomerAuthByEmail,
  getCustomerBookingGroups,
  getBookingEventsForGroup,
  recordBookingEvent,
  getPointBalanceAndLog,
  getMemberCoupons,
  getUsableCouponsForSpace,
  getFavorites,
  addFavorite,
  removeFavorite,
  getRebookTemplate,
  getUsualBookingForCustomer,
  getSpaceById,
  getMemberTickets,
  getUsableTicketsForSpace,
  getSystemSetting,
  getDocumentsForCustomer,
  getBookingGroupByNumber,
  getBookingsByGroup,
  getCancelPolicies,
  buildTicketCancelPlan,
  buildCouponRestoreStmts,
  refundBookingPoints,
  createChangeRequest,
  createChangeSettlement,
  type ChangeRequestType,
  type ChangeSettlementDirection,
} from '../db/repository';
import { hashPassword, verifyPassword } from '../lib/auth';
import { adminRecipients } from '../lib/notify';
import { quoteCancellation } from '../lib/cancellation-service';
import { quoteReschedule } from '../lib/reschedule-quote';
import { executeReschedule } from '../lib/reschedule-exec';
import { computeCancelCharge, selectCancelPolicy, type CancelPolicyTier } from '../lib/cancellation';
import { computeChangeSettlement } from '../lib/change-settlement';
import { cancelFormulaLines, rescheduleFormulaLines } from '../lib/settlement-formula';
import { createCardSwitchSession } from '../lib/payment-switch';
import { deleteBookingFromCalendar } from '../lib/gcal-sync';
import { claimPendingTicketsForCustomer } from '../lib/ticket-migration';
import { pointExpiryStatus } from '../lib/points';
import { nowJST, todayJST } from '../lib/clock';
import {
  sendEmail,
  changeRequestReceivedEmail,
  adminChangeRequestEmail,
  changeSettlementReceivedEmail,
  adminChangeSettlementPendingEmail,
} from '../lib/email';

const app = new Hono<AppBindings>();

// すべてログイン必須
app.use('*', requireAuth);

/** GET /api/mypage/profile 基本情報 */
app.get('/profile', async (c) => {
  const profile = await getCustomerProfile(c.env.DB, c.get('customer').id);
  return c.json({ profile });
});

/** PUT /api/mypage/profile 基本情報更新 */
app.put('/profile', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  await updateCustomerProfile(c.env.DB, c.get('customer').id, {
    companyName: body.companyName,
    contactName: body.contactName,
    phone: body.phone,
    postalCode: body.postalCode,
    address: body.address,
    invoiceNumber: body.invoiceNumber,
  });
  const profile = await getCustomerProfile(c.env.DB, c.get('customer').id);
  return c.json({ profile });
});

/** PUT /api/mypage/password パスワード変更 */
app.put('/password', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { currentPassword, newPassword } = body as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return c.json({ error: '現在のパスワードと、8文字以上の新パスワードが必要です' }, 400);
  }
  const cust = await getCustomerAuthByEmail(c.env.DB, c.get('customer').email);
  if (!cust?.password_hash || !(await verifyPassword(currentPassword, cust.password_hash))) {
    return c.json({ error: '現在のパスワードが違います' }, 401);
  }
  await updateCustomerPassword(c.env.DB, c.get('customer').id, await hashPassword(newPassword));
  return c.json({ ok: true });
});

/** GET /api/mypage/bookings 予約履歴 */
app.get('/bookings', async (c) => {
  const bookings = await getCustomerBookingGroups(c.env.DB, c.get('customer').id);
  return c.json({ bookings });
});

/**
 * POST /api/mypage/bookings/:number/switch-to-card 支払い方法をカードに切替（本人のみ）
 * 未入金の銀行振込／コンビニ／請求書払いの予約に、全額のカード決済リンクを発行して返す。
 * カード入金で自動的に「入金済み・確定」になり、旧・未入金PaymentIntentはキャンセルされる。
 */
app.post('/bookings/:number/switch-to-card', async (c) => {
  const db = c.env.DB;
  const g = await getBookingGroupByNumber(db, c.req.param('number'));
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (!g.customer_id || g.customer_id !== c.get('customer').id) {
    return c.json({ error: 'この予約は対象外です' }, 403);
  }
  const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  const r = await createCardSwitchSession(c.env, g, origin);
  if (!r.ok) return c.json({ error: r.error }, (r.httpStatus ?? 400) as 400);
  return c.json({ ok: true, url: r.url });
});

/** GET /api/mypage/usual 「いつもの予約」（最頻スペースの代表予約）#98 */
app.get('/usual', async (c) => {
  const usual = await getUsualBookingForCustomer(c.env.DB, c.get('customer').id);
  return c.json({ usual });
});

/** GET /api/mypage/rebook-template?group=<id> 「同じ条件で予約」用テンプレート（本人のみ）#98 */
app.get('/rebook-template', async (c) => {
  const groupId = (c.req.query('group') || '').trim();
  if (!groupId) return c.json({ error: 'group required' }, 400);
  const t = await getRebookTemplate(c.env.DB, c.get('customer').id, groupId);
  if (!t) return c.json({ error: 'not found' }, 404);
  if ('forbidden' in t) return c.json({ error: 'この予約は対象外です' }, 403);
  return c.json({ template: t });
});

/** GET /api/mypage/bookings/:number/history 予約の変更履歴（本人のみ）#93 */
app.get('/bookings/:number/history', async (c) => {
  const db = c.env.DB;
  const g = await getBookingGroupByNumber(db, c.req.param('number'));
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (!g.customer_id || g.customer_id !== c.get('customer').id) {
    return c.json({ error: 'この予約は対象外です' }, 403);
  }
  const events = await getBookingEventsForGroup(db, g.id);
  return c.json({ events });
});

/**
 * GET /api/mypage/bookings/:number/cancel-quote キャンセル時の確定額（キャンセル料・返金額）#100
 * お客様がキャンセルを選んだときに、発生金額を事前提示するために使う。
 */
app.get('/bookings/:number/cancel-quote', async (c) => {
  const db = c.env.DB;
  const customer = c.get('customer');
  const g = await getBookingGroupByNumber(db, c.req.param('number'));
  if (!g || !g.customer_id || g.customer_id !== customer.id) return c.json({ error: 'not found' }, 404);
  if (g.status === 'cancelled') return c.json({ error: '既にキャンセル済みです' }, 400);
  const bookings = await getBookingsByGroup(db, g.id);
  const now = nowJST();
  const quote = await quoteCancellation(db, g, bookings, now);
  // チケット払いの予約は現金キャンセル料¥0。前日以前は時間返還／当日は失効（返還なし）。
  const nonCancelled = bookings.filter((b) => b.status !== 'cancelled');
  const earliest = nonCancelled.map((b) => b.date).sort()[0] || g.original_date || now.slice(0, 10);
  const ticketPlan = await buildTicketCancelPlan(db, g.id, earliest, now.slice(0, 10));
  const ticket = ticketPlan ? { isTicket: true, action: ticketPlan.action, hours: ticketPlan.hours } : { isTicket: false };
  // チケット払いは現金の請求・返金は発生しない（見積り額を0に上書き）。
  const q = ticketPlan ? { ...quote, cancelFee: 0, refundAmount: 0 } : quote;
  // 計算式（内訳）を同梱：モーダルとメールで同一の文言にする（settlement-formula）。
  const space = await getSpaceById(db, g.space_id);
  const formula = cancelFormulaLines({
    spaceName: space?.name ?? '',
    daysBefore: q.daysBefore,
    chargePctMax: q.chargePctMax,
    cancelFee: q.cancelFee,
    paidAmount: q.paidAmount,
    refundAmount: q.refundAmount,
    totalAmount: q.totalAmount,
    breakdown: q.breakdown,
    ticket,
  });
  // 支払方法も返す（'invoice'＝自社口座への直接振込のみ、返金時に振込手数料の注記を表示）
  return c.json({ ...q, paymentMethod: g.payment_method, ticket, formula });
});

/**
 * GET /api/mypage/bookings/:number/reschedule-quote?date=&start=&end= 日時変更の差額見積 #100
 * お客様が日時変更を希望したとき、追加請求／返金の金額を事前提示するために使う（確定はしない）。
 */
app.get('/bookings/:number/reschedule-quote', async (c) => {
  const db = c.env.DB;
  const customer = c.get('customer');
  const g = await getBookingGroupByNumber(db, c.req.param('number'));
  if (!g || !g.customer_id || g.customer_id !== customer.id) return c.json({ error: 'not found' }, 404);
  if (g.status === 'cancelled') return c.json({ error: '既にキャンセル済みです' }, 400);
  const date = (c.req.query('date') ?? '').trim();
  const start = (c.req.query('start') ?? '').trim();
  const end = (c.req.query('end') ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
    return c.json({ error: 'date/start/end を指定してください' }, 400);
  }
  const space = await getSpaceById(db, g.space_id);
  if (!space) return c.json({ error: 'space not found' }, 404);
  // 当初利用日基準のキャンセル料率を算出（減額の按分・キャンセル扱い判定に使用）。
  // POST /reschedule の実処理と同一ロジックにして、表示額＝承認時の実精算額を一致させる。
  const now = nowJST();
  const today = now.slice(0, 10);
  const oldRows = await getBookingsByGroup(db, g.id);
  const refDate = g.original_date || oldRows.map((b) => b.date).sort()[0] || today;
  const originalTotal = g.original_total_amount ?? g.total_amount;
  const policiesAll = await getCancelPolicies(db);
  const tiers: CancelPolicyTier[] = selectCancelPolicy(
    policiesAll.map((p) => ({ spaceId: p.space_id, daysBefore: p.days_before, chargePct: p.charge_pct, cutoffTime: p.cutoff_time })),
    g.space_id,
  );
  const cancelChargePct = computeCancelCharge(tiers, refDate, now, originalTotal).chargePct;
  const quote = await quoteReschedule(db, g, space, [{ date, startTime: start, endTime: end }], cancelChargePct);
  // 計算式（内訳）を同梱：モーダルとメールで同一の文言にする（settlement-formula）。
  const formula = rescheduleFormulaLines({
    spaceName: space.name,
    kind: quote.settlement.kind,
    currentTotal: quote.currentTotal,
    newTotal: quote.newTotal,
    cancelChargePct: quote.cancelChargePct,
    refund: quote.settlement.refund,
    charge: quote.settlement.charge,
    ticket: quote.ticket,
  });
  return c.json({ ...quote, formula });
});

/**
 * POST /api/mypage/bookings/:number/cancel 会員のキャンセル申込＝即時実行＋精算待ち作成（Phase B）
 * docs/unified-change-cancel-policy.md §5。
 * その場でキャンセルを実行（枠解放・カレンダー削除・ポイント/チケット/クーポン返却）。
 * 返金の実処理は行わず、返金額を change_settlements に pending 記録し、顧客＋管理者へ通知。
 */
app.post('/bookings/:number/cancel', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const customer = c.get('customer');
  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (!g.customer_id || g.customer_id !== customer.id) {
    return c.json({ error: 'この予約はキャンセル対象外です' }, 403);
  }
  if (g.status === 'cancelled') return c.json({ error: '既にキャンセル済みです' }, 400);
  if (g.status === 'tentative') return c.json({ error: '商談中の予約はオンラインでキャンセルできません' }, 400);

  const now = nowJST();
  const today = now.slice(0, 10);
  const bookings = (await getBookingsByGroup(db, g.id)).filter((b) => b.status !== 'cancelled');

  // チケット払い：現金キャンセル料¥0。前々日まで返還／当日・前日失効。
  const earliest = bookings.map((b) => b.date).sort()[0] || g.original_date || today;
  const ticketPlan = await buildTicketCancelPlan(db, g.id, earliest, today);

  // キャンセル見積り（当初利用日基準・確定額）。チケットは現金0に上書き。
  const quote = await quoteCancellation(db, g, bookings, now);
  const refundAmount = ticketPlan ? 0 : quote.refundAmount;

  // クーポン利用があれば残時間を返却（チケット・ポイントと同様）。
  const couponRestore = await buildCouponRestoreStmts(db, g.id);

  // キャンセルを即時実行（cancellation_log・枠解放・チケット/クーポン返却）
  const stmts: D1PreparedStatement[] = [];
  for (const b of quote.breakdown) {
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
          b.bookingId,
          g.customer_id ?? '',
          now,
          b.daysBefore,
          ticketPlan ? 0 : b.chargePct,
          b.price,
          ticketPlan ? 0 : b.cancelFee,
        ),
    );
    stmts.push(db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(b.bookingId));
  }
  stmts.push(db.prepare("UPDATE booking_groups SET status = 'cancelled' WHERE id = ?").bind(g.id));
  if (ticketPlan?.action === 'restore') stmts.push(...ticketPlan.restoreStmts);
  if (couponRestore) stmts.push(...couponRestore.stmts);
  await db.batch(stmts);

  // ポイント返還（使用があれば）
  await refundBookingPoints(db, g.id, g.customer_id, now);

  // Googleカレンダーからイベント削除
  const space = await getSpaceById(db, g.space_id);
  await deleteBookingFromCalendar(c.env, space?.google_calendar_id ?? null, bookings.map((b) => b.google_event_id));

  // 精算待ち（pending）を記録：返金は管理者承認時に実処理する。
  const direction: ChangeSettlementDirection = refundAmount > 0 ? 'refund' : 'none';
  const noteParts: string[] = [];
  if (ticketPlan) noteParts.push(ticketPlan.action === 'restore' ? `チケット${ticketPlan.hours}時間を返還しました（現金精算なし）。` : `チケット${ticketPlan.hours}時間は失効します（当日・前日・現金精算なし）。`);
  else noteParts.push(`キャンセル料 ¥${Math.round(quote.cancelFee).toLocaleString('ja-JP')}／ご返金額 ¥${Math.round(refundAmount).toLocaleString('ja-JP')}`);
  if (couponRestore) noteParts.push(`クーポン${couponRestore.hours}時間を返却しました。`);
  const note = noteParts.join(' ');
  // 計算式（内訳）：モーダル(cancel-quote)と同一の文言。精算待ちに保存し、承認メールでも再利用する。
  const cancelBreakdown = cancelFormulaLines({
    spaceName: space?.name ?? '',
    daysBefore: quote.daysBefore,
    chargePctMax: quote.chargePctMax,
    cancelFee: ticketPlan ? 0 : quote.cancelFee,
    paidAmount: quote.paidAmount,
    refundAmount,
    totalAmount: quote.totalAmount,
    breakdown: quote.breakdown,
    ticket: ticketPlan ? { isTicket: true, action: ticketPlan.action, hours: ticketPlan.hours } : { isTicket: false },
  }).join('\n');
  const settlementId = await createChangeSettlement(
    db,
    {
      groupId: g.id,
      bookingNumber: number,
      customerId: g.customer_id,
      spaceId: g.space_id,
      type: 'cancel',
      kind: 'cancel',
      direction,
      quotedAmount: refundAmount,
      paymentMethod: g.payment_method,
      oldItems: bookings.map((b) => ({ date: b.date, startTime: b.start_time, endTime: b.end_time })),
      newItems: null,
      note,
      breakdown: cancelBreakdown,
    },
    now,
  );

  // 変更履歴にキャンセル実行を記録（キャンセル実行日＝now が履歴に残る）。#93
  try {
    await recordBookingEvent(
      db,
      { groupId: g.id, type: 'cancel', summary: `キャンセルを受け付けました（マイページ）：${note}`, amount: refundAmount || null, actor: 'customer' },
      now,
    );
  } catch { /* 履歴の記録失敗はキャンセル自体を妨げない */ }

  // メール（顧客＋管理者）
  const custName = customer.contactName || 'お客様';
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: customer.email,
      ...changeSettlementReceivedEmail({
        customerName: custName,
        bookingNumber: number,
        spaceName: space?.name ?? '',
        type: 'cancel',
        direction,
        amount: refundAmount,
        note,
        breakdown: cancelBreakdown,
      }),
    }),
  );
  const admins = await adminRecipients(c.env, g.space_id);
  if (admins.length) {
    const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        to: admins,
        ...adminChangeSettlementPendingEmail({
          bookingNumber: number,
          spaceName: space?.name ?? '',
          eventName: g.event_name,
          type: 'cancel',
          direction,
          amount: refundAmount,
          paymentMethod: g.payment_method,
          customerName: custName,
          customerEmail: customer.email,
          note,
          breakdown: cancelBreakdown,
          adminUrl: `${origin}/admin.html`,
        }),
      }),
    );
  }

  return c.json({
    ok: true,
    settlementId,
    status: 'cancelled',
    direction,
    quotedAmount: refundAmount,
    cancelFee: ticketPlan ? 0 : quote.cancelFee,
    ticket: ticketPlan ? { isTicket: true, action: ticketPlan.action, hours: ticketPlan.hours } : { isTicket: false },
    coupon: couponRestore ? { restoredHours: couponRestore.hours } : null,
    message: '申請を受け付けました。金額は担当者の確認後に確定します。',
  });
});

/**
 * POST /api/mypage/bookings/:number/reschedule 会員の日時変更申込＝即時実行（新枠へ移動）＋精算待ち作成（Phase B）
 * docs/unified-change-cancel-policy.md §5。
 * body: { items: [{date,startTime,endTime,isResidence?}] }
 * その場で新枠へ移動（旧枠解放・カレンダー同期）。金額は computeChangeSettlement で算出し pending 記録。
 */
app.post('/bookings/:number/reschedule', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const customer = c.get('customer');
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
  if (!g.customer_id || g.customer_id !== customer.id) {
    return c.json({ error: 'この予約は変更対象外です' }, 403);
  }
  if (g.status === 'cancelled') return c.json({ error: 'キャンセル済みの予約は変更できません' }, 400);
  if (g.status === 'tentative') return c.json({ error: '商談中の予約はオンラインで変更できません' }, 400);

  const space = await getSpaceById(db, g.space_id);
  if (!space || !space.is_active) return c.json({ error: 'space not found' }, 404);

  const now = nowJST();
  const today = todayJST();
  const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;

  // 当初利用日基準のキャンセル料率（変更精算の按分に使う）。当初金額はグループの original_total_amount。
  const oldRows = await getBookingsByGroup(db, g.id);
  const refDate = g.original_date || oldRows.map((b) => b.date).sort()[0] || today;
  const originalTotal = g.original_total_amount ?? g.total_amount;
  const policiesAll = await getCancelPolicies(db);
  const tiers: CancelPolicyTier[] = selectCancelPolicy(
    policiesAll.map((p) => ({ spaceId: p.space_id, daysBefore: p.days_before, chargePct: p.charge_pct, cutoffTime: p.cutoff_time })),
    g.space_id,
  );
  const cancelChargePct = computeCancelCharge(tiers, refDate, now, originalTotal).chargePct;

  // 枠移動を即時実行（チケットは統一ポリシー §4）
  const exec = await executeReschedule(c.env, g, space, body.items, today, now, origin);
  if (!exec.ok) {
    return c.json(
      exec.details !== undefined
        ? { error: exec.error, details: exec.details }
        : exec.code
          ? { error: exec.error, code: exec.code }
          : { error: exec.error },
      exec.httpStatus as 400,
    );
  }

  // 精算額を算出。チケット予約は現金精算なし（direction none）。
  let direction: ChangeSettlementDirection;
  let quotedAmount: number;
  let kind: string;
  let note: string;
  if (exec.ticket.isTicket) {
    direction = 'none';
    quotedAmount = 0;
    kind = 'move';
    note =
      exec.ticket.action === 'restore_full'
        ? 'チケット予約の変更：消費時間を全額返還し、新しい予約で改めて消費しました（現金精算なし）。'
        : exec.ticket.action === 'partial_forfeit'
          ? `チケット予約の変更：減少分（${(exec.ticket.oldHours ?? 0) - (exec.ticket.newHours ?? 0)}時間）は失効、残りを付け替えました（現金精算なし）。`
          : 'チケット予約の変更：消費を新しい予約へ付け替えました（現金精算なし）。';
  } else {
    const s = computeChangeSettlement(originalTotal, exec.newTotal, cancelChargePct);
    kind = s.kind;
    note = s.note;
    if (s.kind === 'increase' || s.kind === 'cancel_treatment') {
      direction = 'charge';
      quotedAmount = s.charge;
    } else if (s.kind === 'decrease') {
      direction = 'refund';
      quotedAmount = s.refund;
    } else {
      direction = 'none';
      quotedAmount = 0;
    }
  }

  // 計算式（内訳）：モーダル(reschedule-quote)と同一の文言。精算待ちに保存し、承認メールでも再利用する。
  const rescheduleBreakdown = rescheduleFormulaLines({
    spaceName: space.name,
    kind: kind as 'move' | 'increase' | 'decrease' | 'cancel_treatment',
    currentTotal: g.total_amount,
    newTotal: exec.newTotal,
    cancelChargePct,
    refund: direction === 'refund' ? quotedAmount : 0,
    charge: direction === 'charge' ? quotedAmount : 0,
    ticket: exec.ticket.isTicket,
  }).join('\n');
  const settlementId = await createChangeSettlement(
    db,
    {
      groupId: g.id,
      bookingNumber: number,
      customerId: g.customer_id,
      spaceId: g.space_id,
      type: 'reschedule',
      kind,
      direction,
      quotedAmount,
      paymentMethod: g.payment_method,
      oldItems: exec.oldDays,
      newItems: exec.newDays,
      note,
      breakdown: rescheduleBreakdown,
    },
    now,
  );

  // メール（顧客＋管理者）
  const custName = customer.contactName || 'お客様';
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: customer.email,
      ...changeSettlementReceivedEmail({
        customerName: custName,
        bookingNumber: number,
        spaceName: space.name,
        type: 'reschedule',
        direction,
        amount: quotedAmount,
        note,
        breakdown: rescheduleBreakdown,
        oldDays: exec.oldDays,
        newDays: exec.newDays,
      }),
    }),
  );
  const admins = await adminRecipients(c.env, g.space_id);
  if (admins.length) {
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        to: admins,
        ...adminChangeSettlementPendingEmail({
          bookingNumber: number,
          spaceName: space.name,
          eventName: g.event_name,
          type: 'reschedule',
          direction,
          amount: quotedAmount,
          paymentMethod: g.payment_method,
          customerName: custName,
          customerEmail: customer.email,
          note,
          breakdown: rescheduleBreakdown,
          oldDays: exec.oldDays,
          newDays: exec.newDays,
          adminUrl: `${origin}/admin.html`,
        }),
      }),
    );
  }

  return c.json({
    ok: true,
    settlementId,
    kind,
    direction,
    quotedAmount,
    newTotal: exec.newTotal,
    ticket: exec.ticket,
    calendarWarning: exec.calendarWarning,
    message: '申請を受け付けました。金額は担当者の確認後に確定します。',
  });
});

/**
 * POST /api/mypage/bookings/:number/change-request 予約変更リクエスト（#54）
 * 会員が自分の予約に対して変更希望（日時変更/オプション/キャンセル/その他）を送信。
 * 管理者が承認するまで予約自体は変わらない（受付のみ）。
 * body: { type, message, proposedItems?: [{date,startTime,endTime}] }
 */
app.post('/bookings/:number/change-request', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const customer = c.get('customer');
  const body = (await c.req.json().catch(() => ({}))) as {
    type?: string;
    message?: string;
    proposedItems?: Array<{ date?: string; startTime?: string; endTime?: string }>;
  };
  const validTypes: ChangeRequestType[] = ['reschedule', 'option', 'cancel', 'other'];
  if (!body.type || !validTypes.includes(body.type as ChangeRequestType)) {
    return c.json({ error: 'type(reschedule/option/cancel/other) は必須です' }, 400);
  }
  const type = body.type as ChangeRequestType;
  const message = (body.message ?? '').trim();
  if (!message && type !== 'cancel') {
    return c.json({ error: 'ご希望・ご連絡事項を入力してください' }, 400);
  }

  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);
  // 本人の予約のみ受付（他人の予約番号を弾く）
  if (!g.customer_id || g.customer_id !== customer.id) {
    return c.json({ error: 'この予約は変更リクエストの対象外です' }, 403);
  }
  if (g.status === 'cancelled') {
    return c.json({ error: 'キャンセル済みの予約です' }, 400);
  }

  // 旧「3日前以降はフォーム誘導」ゲート（evaluateCancel）は廃止（統一ポリシー §5・2026-09-06）。
  // キャンセル/変更は全期間オンラインで申込可能（申込＝即時反映／お金は管理者承認）。
  // ※この change-request 経路は相談用として残す（実行を伴う申込は cancel / reschedule 経路）。

  // 日時変更の希望枠（任意・あれば承認時にワンクリック適用の材料になる）
  let proposed: Array<{ date: string; startTime: string; endTime: string }> | null = null;
  if (type === 'reschedule' && Array.isArray(body.proposedItems)) {
    const cleaned = body.proposedItems
      .filter((i) => i && i.date && i.startTime && i.endTime)
      .map((i) => ({ date: String(i.date), startTime: String(i.startTime), endTime: String(i.endTime) }));
    if (cleaned.length) proposed = cleaned;
  }

  const space = await getSpaceById(db, g.space_id);
  const spaceName = space?.name ?? '';
  const now = nowJST();

  // キャンセル希望は確定額（キャンセル料・返金額）を算出し、記録と管理者通知に含める（#100）
  let cancelFee: number | undefined;
  let refundAmount: number | undefined;
  if (type === 'cancel') {
    const bookings = await getBookingsByGroup(db, g.id);
    const q = await quoteCancellation(db, g, bookings, now);
    cancelFee = q.cancelFee;
    refundAmount = q.refundAmount;
  }
  const yen = (n: number) => '¥' + Math.round(n).toLocaleString('ja-JP');
  let agreedNote = cancelFee !== undefined ? `\n【お客様が同意した金額】キャンセル料 ${yen(cancelFee)}／ご返金額 ${yen(refundAmount ?? 0)}` : '';
  // 日時変更で差額が生じる場合、お客様が同意した差額を記録に残す（#100 / 統一ポリシー §2）。
  // reschedule-quote と同じキャンセル料率を渡し、記録＝実精算（承認時）を一致させる。
  if (type === 'reschedule' && proposed && space) {
    try {
      const today = now.slice(0, 10);
      const oldRows = await getBookingsByGroup(db, g.id);
      const refDate = g.original_date || oldRows.map((b) => b.date).sort()[0] || today;
      const originalTotal = g.original_total_amount ?? g.total_amount;
      const policiesAll = await getCancelPolicies(db);
      const tiers: CancelPolicyTier[] = selectCancelPolicy(
        policiesAll.map((p) => ({ spaceId: p.space_id, daysBefore: p.days_before, chargePct: p.charge_pct, cutoffTime: p.cutoff_time })),
        g.space_id,
      );
      const pct = computeCancelCharge(tiers, refDate, now, originalTotal).chargePct;
      const rq = await quoteReschedule(db, g, space, proposed, pct);
      const s = rq.settlement;
      if (rq.ticket) {
        /* チケットは現金精算なし＝注記不要 */
      } else if (s.kind === 'cancel_treatment') {
        agreedNote += `\n【お客様が同意した金額】キャンセル扱い：旧予約は返金なし・新予約は満額 ${yen(s.charge)}`;
      } else if (s.kind === 'increase') {
        agreedNote += `\n【お客様が同意した金額】追加請求 ${yen(s.charge)}（変更後 ${yen(rq.newTotal)}）`;
      } else if (s.kind === 'decrease') {
        agreedNote += `\n【お客様が同意した金額】ご返金 ${yen(s.refund)}（変更後 ${yen(rq.newTotal)}／減少分の${pct}%はキャンセル料）`;
      } else {
        agreedNote += `\n【お客様が同意した金額】差額なし（${yen(rq.newTotal)}）`;
      }
    } catch (e) {
      /* 見積不可時は金額注記なし（担当者が確認） */
    }
  }

  const id = await createChangeRequest(
    db,
    { groupId: g.id, customerId: customer.id, bookingNumber: number, type, message: (message || '（キャンセル希望）') + agreedNote, contact: customer.email, proposedItems: proposed },
    now,
  );

  // お客様へ受付確認、管理者へ通知
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: customer.email,
      ...changeRequestReceivedEmail({ customerName: customer.contactName || 'お客様', bookingNumber: number, spaceName, type, message, proposedDays: proposed ?? undefined }),
    }),
  );
  const crAdmins = await adminRecipients(c.env, g.space_id);
  if (crAdmins.length) {
    const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        to: crAdmins,
        ...adminChangeRequestEmail({
          bookingNumber: number,
          spaceName,
          eventName: g.event_name,
          type,
          message: message || '（キャンセル希望）',
          customerName: customer.contactName || 'お客様',
          customerEmail: customer.email,
          proposedDays: proposed ?? undefined,
          cancelFee,
          refundAmount,
          adminUrl: `${origin}/admin.html`,
        }),
      }),
    );
  }

  return c.json({ id, status: 'pending', message: '変更リクエストを受け付けました。担当者の承認をもって変更が確定します。' }, 201);
});

/** GET /api/mypage/points ポイント残高・履歴・有効期限 */
app.get('/points', async (c) => {
  const { balance, log } = await getPointBalanceAndLog(c.env.DB, c.get('customer').id);
  // 有効期限（#78）：残高があれば最終活動（最新の履歴）から1年ローリングで算出
  let expiry: string | null = null;
  if (balance > 0 && log.length > 0) {
    const lastAt = String((log[0] as { created_at?: string }).created_at ?? '').slice(0, 10);
    if (lastAt) expiry = pointExpiryStatus(lastAt, todayJST()).expiryDate;
  }
  return c.json({ balance, log, expiry });
});

/** GET /api/mypage/coupons 保有クーポン一覧 */
app.get('/coupons', async (c) => {
  const coupons = await getMemberCoupons(c.env.DB, c.get('customer').id);
  return c.json({ coupons });
});

/** GET /api/mypage/usable-coupons?spaceId=xxx 指定スペースで「今」使えるクーポン（予約画面の自動候補用） */
app.get('/usable-coupons', async (c) => {
  const spaceId = (c.req.query('spaceId') || '').trim();
  if (!spaceId) return c.json({ coupons: [] });
  const coupons = await getUsableCouponsForSpace(c.env.DB, c.get('customer').id, spaceId, todayJST());
  return c.json({ coupons });
});

/** GET /api/mypage/tickets 保有チケット一覧 */
app.get('/tickets', async (c) => {
  const customer = c.get('customer');
  // #82 既存チケットの移行：メール一致の付与待ちチケットがあれば、この時点で自動付与する
  // （登録/ログイン方法を問わず、マイページを開いた時点で確実に付与される。idempotent）。
  try {
    await claimPendingTicketsForCustomer(c.env.DB, customer.id, customer.email, todayJST());
  } catch (e) {
    /* 付与に失敗しても一覧表示は続行（次回アクセスで再試行される） */
  }
  const tickets = await getMemberTickets(c.env.DB, customer.id, todayJST());
  const contactUrl = (await getSystemSetting(c.env.DB, 'contact_url')) || 'https://space-albe.com/contact/';
  return c.json({ tickets, contactUrl });
});

/** GET /api/mypage/documents 会員の書類（請求書・領収書）一覧（#41） */
app.get('/documents', async (c) => {
  const docs = await getDocumentsForCustomer(c.env.DB, c.get('customer').id);
  return c.json({
    documents: docs.map((d) => ({
      type: d.type,
      bookingNumber: d.booking_number,
      total: d.total_amount,
      issuedAt: d.issued_at,
      url: '/api/documents/' + d.public_token,
    })),
  });
});

/** GET /api/mypage/usable-tickets?spaceId=xxx 指定スペースで使えるチケット */
app.get('/usable-tickets', async (c) => {
  const spaceId = c.req.query('spaceId');
  if (!spaceId) return c.json({ tickets: [] });
  const customer = c.get('customer');
  // #82 予約時にも付与待ちチケットを取り込む（マイページ未訪問でも予約でチケットが使える）
  try {
    await claimPendingTicketsForCustomer(c.env.DB, customer.id, customer.email, todayJST());
  } catch (e) {
    /* 付与失敗時も一覧取得は続行 */
  }
  const tickets = await getUsableTicketsForSpace(c.env.DB, customer.id, spaceId, todayJST());
  return c.json({ tickets });
});

/** GET /api/mypage/favorites お気に入り一覧 */
app.get('/favorites', async (c) => {
  const favorites = await getFavorites(c.env.DB, c.get('customer').id);
  return c.json({ favorites });
});

/** POST /api/mypage/favorites お気に入り追加/削除 body:{spaceId, action:'add'|'remove'} */
app.post('/favorites', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { spaceId, action } = body as { spaceId?: string; action?: string };
  if (!spaceId) return c.json({ error: 'spaceId は必須です' }, 400);
  const space = await getSpaceById(c.env.DB, spaceId);
  if (!space) return c.json({ error: 'space not found' }, 404);

  if (action === 'remove') {
    await removeFavorite(c.env.DB, c.get('customer').id, spaceId);
  } else {
    await addFavorite(c.env.DB, c.get('customer').id, spaceId, nowJST());
  }
  const favorites = await getFavorites(c.env.DB, c.get('customer').id);
  return c.json({ favorites });
});

export default app;
