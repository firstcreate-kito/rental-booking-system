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

const app = new Hono<AppBindings>();

app.use('*', logger());

/**
 * ベーシック認証（開発中の公開ゲート）。
 * BASIC_AUTH_USER と BASIC_AUTH_PASS の両方が設定されているときだけ有効。
 * 未設定なら素通り（ローカル開発や一般公開時はゲートなし）。
 * ※認証情報は ASCII で設定してください。
 */
app.use('*', async (c, next) => {
  const user = c.env.BASIC_AUTH_USER;
  const pass = c.env.BASIC_AUTH_PASS;
  if (!user || !pass) return next();

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
      return next();
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

/**
 * 静的アセット（public/）を Worker 経由で配信する。
 * ベーシック認証を静的ファイルにも効かせるため、assets を Worker より先に
 * 配信せず（run_worker_first）、ここで ASSETS バインディングに委譲する。
 */
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
