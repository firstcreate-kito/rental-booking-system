import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  isBlacklisted,
  getCustomerAuthByEmail,
  createSession,
  deleteSession,
  updateLastLogin,
} from '../db/repository';
import { hashPassword, verifyPassword, generateToken, sessionExpiry, isValidEmail } from '../lib/auth';
import { nowJST } from '../lib/clock';

const app = new Hono<AppBindings>();

const BLACKLIST_MESSAGE = '申し訳ございませんが、ご登録をお受けすることができません。';
const MIN_PASSWORD = 8;

/** POST /api/auth/register 会員登録（ゲスト昇格対応） */
app.post('/register', async (c) => {
  const db = c.env.DB;
  let body: { email?: string; password?: string; contactName?: string; phone?: string; companyName?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const { email, password, contactName, phone, companyName } = body;
  if (!email || !isValidEmail(email)) return c.json({ error: '有効なメールアドレスを入力してください' }, 400);
  if (!password || password.length < MIN_PASSWORD) {
    return c.json({ error: `パスワードは${MIN_PASSWORD}文字以上にしてください` }, 400);
  }
  if (!contactName || !phone) return c.json({ error: 'お名前・電話番号は必須です' }, 400);

  if (await isBlacklisted(db, email, phone)) return c.json({ error: BLACKLIST_MESSAGE }, 403);

  const existing = await getCustomerAuthByEmail(db, email);
  const now = nowJST();
  const passwordHash = await hashPassword(password);
  let customerId: string;

  if (existing) {
    if (existing.is_blocked) return c.json({ error: BLACKLIST_MESSAGE }, 403);
    if (existing.password_hash) return c.json({ error: 'このメールアドレスは既に登録されています' }, 409);
    // ゲスト → 会員へ昇格
    customerId = existing.id;
    await db
      .prepare(
        `UPDATE customers SET password_hash = ?, is_registered = 1, contact_name = ?, phone = ?, company_name = COALESCE(?, company_name)
         WHERE id = ?`,
      )
      .bind(passwordHash, contactName, phone, companyName ?? null, customerId)
      .run();
  } else {
    customerId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO customers (id, email, password_hash, is_registered, company_name, contact_name, phone, status_id, created_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, 'general', ?)`,
      )
      .bind(customerId, email, passwordHash, companyName ?? null, contactName, phone, now)
      .run();
  }

  const token = generateToken();
  await createSession(db, token, customerId, sessionExpiry(), now);
  return c.json({ token, customer: { id: customerId, email, contactName } }, 201);
});

/** POST /api/auth/login ログイン */
app.post('/login', async (c) => {
  const db = c.env.DB;
  let body: { email?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (!body.email || !body.password) return c.json({ error: 'メールとパスワードは必須です' }, 400);

  const cust = await getCustomerAuthByEmail(db, body.email);
  if (!cust || !cust.password_hash) return c.json({ error: 'メールまたはパスワードが違います' }, 401);
  if (cust.is_blocked) return c.json({ error: 'このアカウントはご利用いただけません' }, 403);
  if (!(await verifyPassword(body.password, cust.password_hash))) {
    return c.json({ error: 'メールまたはパスワードが違います' }, 401);
  }

  const now = nowJST();
  const token = generateToken();
  await createSession(db, token, cust.id, sessionExpiry(), now);
  await updateLastLogin(db, cust.id, now);
  return c.json({
    token,
    customer: { id: cust.id, email: cust.email, contactName: cust.contact_name, statusId: cust.status_id },
  });
});

/** POST /api/auth/logout ログアウト */
app.post('/logout', async (c) => {
  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (token) await deleteSession(c.env.DB, token);
  return c.json({ ok: true });
});

export default app;
