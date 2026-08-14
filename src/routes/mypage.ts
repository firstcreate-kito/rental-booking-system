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
} from '../db/repository';
import { hashPassword, verifyPassword } from '../lib/auth';
import { nowJST, todayJST } from '../lib/clock';

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

/** GET /api/mypage/points ポイント残高・履歴 */
app.get('/points', async (c) => {
  const { balance, log } = await getPointBalanceAndLog(c.env.DB, c.get('customer').id);
  return c.json({ balance, log });
});

/** GET /api/mypage/coupons 保有クーポン一覧 */
app.get('/coupons', async (c) => {
  const coupons = await getMemberCoupons(c.env.DB, c.get('customer').id);
  return c.json({ coupons });
});

/** GET /api/mypage/tickets 保有チケット一覧 */
app.get('/tickets', async (c) => {
  const tickets = await getMemberTickets(c.env.DB, c.get('customer').id);
  const contactUrl = (await getSystemSetting(c.env.DB, 'contact_url')) || 'https://space-albe.com/contact/';
  return c.json({ tickets, contactUrl });
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
