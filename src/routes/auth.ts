import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  isBlacklisted,
  getCustomerAuthByEmail,
  createSession,
  deleteSession,
  updateLastLogin,
  createPasswordResetToken,
  getPasswordResetToken,
  applyPasswordReset,
} from '../db/repository';
import { hashPassword, verifyPassword, generateToken, sessionExpiry, isValidEmail } from '../lib/auth';
import { nowJST } from '../lib/clock';
import { sendEmail, passwordResetEmail } from '../lib/email';

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

/**
 * POST /api/auth/password-reset/request パスワード再設定メールの送付依頼
 * body: { email }
 * セキュリティ上、メールの登録有無に関わらず常に { ok:true } を返す（存在の推測を防ぐ）。
 * 登録済み会員のみ、再設定リンク付きメールを送信する。
 */
app.post('/password-reset/request', async (c) => {
  const db = c.env.DB;
  let body: { email?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const email = (body.email ?? '').trim();
  if (!email || !isValidEmail(email)) return c.json({ error: '有効なメールアドレスを入力してください' }, 400);

  const cust = await getCustomerAuthByEmail(db, email);
  if (cust && cust.password_hash && !cust.is_blocked) {
    const now = nowJST();
    const token = generateToken();
    const expiresAt = nowJST(Date.now() + 60 * 60 * 1000); // 1時間後
    await createPasswordResetToken(db, token, cust.id, expiresAt, now);
    const origin = new URL(c.req.url).origin;
    const resetUrl = `${origin}/reset.html?token=${token}`;
    const mail = passwordResetEmail({
      customerName: cust.contact_name ? String(cust.contact_name) : 'お客様',
      resetUrl,
      expiresLabel: '1時間',
    });
    c.executionCtx.waitUntil(sendEmail(c.env, { to: email, ...mail }));
  }
  return c.json({ ok: true });
});

/**
 * POST /api/auth/password-reset/confirm 新しいパスワードを設定する
 * body: { token, password }
 */
app.post('/password-reset/confirm', async (c) => {
  const db = c.env.DB;
  let body: { token?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const token = (body.token ?? '').trim();
  const password = body.password ?? '';
  if (!token) return c.json({ error: 'リンクが無効です。再度お手続きください。' }, 400);
  if (password.length < MIN_PASSWORD) {
    return c.json({ error: `パスワードは${MIN_PASSWORD}文字以上にしてください` }, 400);
  }
  const row = await getPasswordResetToken(db, token);
  if (!row || row.used) {
    return c.json({ error: 'このリンクは無効か、既に使用済みです。再度お手続きください。' }, 400);
  }
  if (nowJST() > row.expires_at) {
    return c.json({ error: 'リンクの有効期限が切れています。再度お手続きください。' }, 400);
  }
  const passwordHash = await hashPassword(password);
  await applyPasswordReset(db, row.customer_id, passwordHash);
  return c.json({ ok: true });
});

/** POST /api/auth/logout ログアウト */
app.post('/logout', async (c) => {
  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (token) await deleteSession(c.env.DB, token);
  return c.json({ ok: true });
});

export default app;
