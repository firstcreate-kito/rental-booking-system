import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppBindings } from './types';
import spaces from './routes/spaces';
import bookings from './routes/bookings';

const app = new Hono<AppBindings>();

app.use('*', logger());
app.use('/api/*', cors());

/** ヘルスチェック */
app.get('/', (c) => {
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

export default app;
