import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { requireAuth } from '../middleware/auth';
import {
  getCustomerProfile,
  updateCustomerProfile,
  updateCustomerPassword,
  getCustomerAuthByEmail,
  getCustomerBookingGroups,
  getPointBalanceAndLog,
  getMemberCoupons,
  getFavorites,
  addFavorite,
  removeFavorite,
  getSpaceById,
  getMemberTickets,
  getUsableTicketsForSpace,
  getSystemSetting,
  getDocumentsForCustomer,
  getBookingGroupByNumber,
  createChangeRequest,
  type ChangeRequestType,
} from '../db/repository';
import { hashPassword, verifyPassword } from '../lib/auth';
import { adminRecipients } from '../lib/notify';
import { evaluateCancel, leadDays } from '../lib/change-policy';
import { pointExpiryStatus } from '../lib/points';
import { nowJST, todayJST } from '../lib/clock';
import { sendEmail, changeRequestReceivedEmail, adminChangeRequestEmail } from '../lib/email';

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

  // キャンセルは利用日の3日前以降オンライン受付不可 → メールフォーム誘導（#76 Phase 1）
  // 当初利用日を基準に判定。直前キャンセルはキャンセルチャージを口頭で案内できるようにする。
  if (type === 'cancel' && g.original_date) {
    const gate = evaluateCancel(leadDays(g.original_date, todayJST()));
    if (!gate.allowed) return c.json({ error: gate.message, mode: 'form' }, 422);
  }

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
  const id = await createChangeRequest(
    db,
    { groupId: g.id, customerId: customer.id, bookingNumber: number, type, message: message || '（キャンセル希望）', contact: customer.email, proposedItems: proposed },
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

/** GET /api/mypage/tickets 保有チケット一覧 */
app.get('/tickets', async (c) => {
  const tickets = await getMemberTickets(c.env.DB, c.get('customer').id, todayJST());
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
  const tickets = await getUsableTicketsForSpace(c.env.DB, c.get('customer').id, spaceId, todayJST());
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
