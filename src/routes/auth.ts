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
  createLoginChallenge,
  getLoginChallengeByToken,
  getLoginChallengeByEmailCode,
  getRecentCodeAttempts,
  incrementCodeAttempts,
  markLoginChallengeUsed,
  ensureCustomerByEmail,
} from '../db/repository';
import { hashPassword, verifyPassword, generateToken, sessionExpiry, isValidEmail } from '../lib/auth';
import { nowJST } from '../lib/clock';
import { sendEmail, passwordResetEmail, welcomeEmail, magicLinkEmail, loginCodeEmail } from '../lib/email';

/** 6桁のワンタイムコードを生成（暗号的乱数）。 */
function sixDigitCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}
const CODE_MAX_ATTEMPTS = 5;

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

  // 会員登録完了（ウェルカム）メール（#51）。失敗しても登録は成立させる。
  const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: email,
      ...welcomeEmail({ customerName: contactName, mypageUrl: `${origin}/mypage.html`, bookingUrl: `${origin}/` }),
    }),
  );
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

/**
 * POST /api/auth/magic-link/request マジックリンク送付（マイページ用）
 * body: { email }。未登録メールはログイン成立時にその場で会員登録も兼ねる。
 * 常に { ok:true }（存在の推測を防ぐ）。ブラックリストには送らない。
 */
app.post('/magic-link/request', async (c) => {
  const db = c.env.DB;
  let body: { email?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  const email = (body.email ?? '').trim();
  if (!email || !isValidEmail(email)) return c.json({ error: '有効なメールアドレスを入力してください' }, 400);
  if (!(await isBlacklisted(db, email, ''))) {
    const now = nowJST();
    const secret = generateToken();
    const expiresAt = nowJST(Date.now() + 30 * 60 * 1000); // 30分
    await createLoginChallenge(db, { id: crypto.randomUUID(), email, secret, kind: 'link', expiresAt }, now);
    const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
    const loginUrl = `${origin}/mypage.html?magic=${secret}`;
    c.executionCtx.waitUntil(sendEmail(c.env, { to: email, ...magicLinkEmail({ loginUrl, expiresLabel: '30分' }) }));
  }
  return c.json({ ok: true });
});

/**
 * POST /api/auth/magic-link/consume マジックリンクからログイン
 * body: { token }。成功時にセッションを発行。未登録メールは会員を作成。
 */
app.post('/magic-link/consume', async (c) => {
  const db = c.env.DB;
  let body: { token?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  const token = (body.token ?? '').trim();
  if (!token) return c.json({ error: 'リンクが無効です。もう一度お試しください。' }, 400);
  const ch = await getLoginChallengeByToken(db, token);
  if (!ch || ch.used) return c.json({ error: 'このリンクは無効か、既に使用済みです。もう一度お試しください。' }, 400);
  if (nowJST() > ch.expires_at) return c.json({ error: 'リンクの有効期限が切れています。もう一度お試しください。' }, 400);
  const now = nowJST();
  const cust = await ensureCustomerByEmail(db, ch.email, now);
  if (cust.is_blocked) return c.json({ error: 'このアカウントはご利用いただけません' }, 403);
  const sessionToken = generateToken();
  await createSession(db, sessionToken, cust.id, sessionExpiry(), now);
  await markLoginChallengeUsed(db, ch.id);
  await updateLastLogin(db, cust.id, now);
  return c.json({ token: sessionToken, customer: { id: cust.id, email: cust.email, contactName: cust.contact_name } });
});

/**
 * POST /api/auth/login-code/request ワンタイムコード送付（予約フロー・見学フォーム用）
 * body: { email }。画面を離れずに入力できる6桁コードをメール。常に { ok:true }。
 */
app.post('/login-code/request', async (c) => {
  const db = c.env.DB;
  let body: { email?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  const email = (body.email ?? '').trim();
  if (!email || !isValidEmail(email)) return c.json({ error: '有効なメールアドレスを入力してください' }, 400);
  if (!(await isBlacklisted(db, email, ''))) {
    const now = nowJST();
    const code = sixDigitCode();
    const expiresAt = nowJST(Date.now() + 10 * 60 * 1000); // 10分
    await createLoginChallenge(db, { id: crypto.randomUUID(), email, secret: code, kind: 'code', expiresAt }, now);
    c.executionCtx.waitUntil(sendEmail(c.env, { to: email, ...loginCodeEmail({ code, expiresLabel: '10分' }) }));
  }
  return c.json({ ok: true });
});

/**
 * POST /api/auth/login-code/verify ワンタイムコードでログイン
 * body: { email, code }。総当たり防止のため誤入力回数を制限。
 */
app.post('/login-code/verify', async (c) => {
  const db = c.env.DB;
  let body: { email?: string; code?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  const email = (body.email ?? '').trim();
  const code = (body.code ?? '').trim();
  if (!email || !code) return c.json({ error: 'メールアドレスと確認コードを入力してください' }, 400);
  if ((await getRecentCodeAttempts(db, email)) >= CODE_MAX_ATTEMPTS) {
    return c.json({ error: '試行回数の上限に達しました。お手数ですが、確認コードを再送信してください。' }, 429);
  }
  const ch = await getLoginChallengeByEmailCode(db, email, code);
  if (!ch) {
    await incrementCodeAttempts(db, email);
    return c.json({ error: '確認コードが正しくありません。' }, 400);
  }
  if (nowJST() > ch.expires_at) return c.json({ error: '確認コードの有効期限が切れています。再送信してください。' }, 400);
  const now = nowJST();
  const cust = await ensureCustomerByEmail(db, ch.email, now);
  if (cust.is_blocked) return c.json({ error: 'このアカウントはご利用いただけません' }, 403);
  const sessionToken = generateToken();
  await createSession(db, sessionToken, cust.id, sessionExpiry(), now);
  await markLoginChallengeUsed(db, ch.id);
  await updateLastLogin(db, cust.id, now);
  return c.json({ token: sessionToken, customer: { id: cust.id, email: cust.email, contactName: cust.contact_name } });
});

/** POST /api/auth/logout ログアウト */
app.post('/logout', async (c) => {
  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (token) await deleteSession(c.env.DB, token);
  return c.json({ ok: true });
});

export default app;
