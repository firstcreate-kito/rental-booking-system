import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppBindings } from './types';
import spaces from './routes/spaces';
import bookings from './routes/bookings';
import auth from './routes/auth';
import mypage from './routes/mypage';
import signage from './routes/signage';
import admin from './routes/admin';
import tickets from './routes/tickets';
import webhooks from './routes/webhooks';

const app = new Hono<AppBindings>();

app.use('*', logger());

/** ゲート通過印（Cookie）の値。認証情報から一意に導出（漏洩しても資格情報は復元不可）。 */
async function gateToken(user: string, pass: string): Promise<string> {
  const data = new TextEncoder().encode(`albe-gate:${user}:${pass}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ベーシック認証（開発中の公開ゲート）。
 * BASIC_AUTH_USER と BASIC_AUTH_PASS の両方が設定されているときだけ有効。
 * 未設定なら素通り（ローカル開発や一般公開時はゲートなし）。
 *
 * 一度パスワードを通すと通過印の Cookie を発行し、以降は Cookie で判定する。
 * これにより、アプリの Authorization: Bearer（会員/管理者ログイン）と
 * ベーシック認証の Authorization: Basic が衝突しなくなる。
 * ※認証情報は ASCII で設定してください。
 */
app.use('*', async (c, next) => {
  const user = c.env.BASIC_AUTH_USER;
  const pass = c.env.BASIC_AUTH_PASS;
  if (!user || !pass) return next();

  // Stripe など外部サービスからの Webhook は Basic 認証を通せないため除外する
  if (c.req.path.startsWith('/api/webhooks/')) return next();

  const expected = await gateToken(user, pass);

  // 既に通過済み（Cookie）なら Authorization ヘッダに依存せず通す
  const cookie = c.req.header('Cookie') ?? '';
  const passed = cookie.split(';').some((kv) => kv.trim() === `albe_gate=${expected}`);
  if (passed) return next();

  // Basic 認証の検証
  const header = c.req.header('Authorization');
  if (header?.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = '';
    }
    const idx = decoded.indexOf(':');
    if (idx >= 0 && decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass) {
      await next();
      // 通過印の Cookie を付与（ASSETS 応答は不変なので作り直して設定）
      const res = new Response(c.res.body, c.res);
      res.headers.append(
        'Set-Cookie',
        `albe_gate=${expected}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
      );
      c.res = res;
      return;
    }
  }
  return new Response('認証が必要です。', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="ALBE (development)", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
});

app.use('/api/*', cors());

/** ヘルスチェック（JSON） */
app.get('/api/health', (c) => {
  return c.json({
    service: 'albe-booking-api',
    status: 'ok',
    env: c.env.APP_ENV ?? 'unknown',
  });
});

/** DB接続確認用（開発時のみ想定） */
app.get('/api/health/db', async (c) => {
  try {
    const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM spaces').first<{ n: number }>();
    return c.json({ ok: true, spaces: row?.n ?? 0 });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// API ルート
app.route('/api/spaces', spaces);
app.route('/api/bookings', bookings);
app.route('/api/auth', auth);
app.route('/api/mypage', mypage);
app.route('/api/signage', signage);
app.route('/api/admin', admin);
app.route('/api/tickets', tickets);
app.route('/api/webhooks', webhooks);

/**
 * 静的アセット（public/）を Worker 経由で配信する。
 * ベーシック認証を静的ファイルにも効かせるため、assets を Worker より先に
 * 配信せず（run_worker_first）、ここで ASSETS バインディングに委譲する。
 */
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
