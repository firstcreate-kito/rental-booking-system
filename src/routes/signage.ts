import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { getSpaceById, verifySignageToken, getSignageBookings } from '../db/repository';
import { todayJST, nowJST } from '../lib/clock';

const app = new Hono<AppBindings>();

/**
 * GET /api/signage/:spaceId?token=xxxx
 * 当日の確定予約を返す（サイネージ表示用）。
 * - 終了済み予約は自動非表示
 * - 利用中(ongoing) / これから(upcoming) を判定
 * - 商談中・ブロックは表示しない（confirmedのみ）
 */
app.get('/:spaceId', async (c) => {
  const spaceId = c.req.param('spaceId');
  const token = c.req.query('token');
  if (!token) return c.json({ error: 'token is required' }, 401);

  const space = await getSpaceById(c.env.DB, spaceId);
  if (!space || !space.is_active) return c.json({ error: 'space not found' }, 404);

  if (!(await verifySignageToken(c.env.DB, spaceId, token))) {
    return c.json({ error: 'invalid token' }, 403);
  }

  const date = todayJST();
  const nowTime = nowJST().slice(11, 16); // 'HH:MM'
  const all = await getSignageBookings(c.env.DB, spaceId, date);

  // 終了済みを除外し、状態を判定
  const bookings = all
    .filter((b) => b.end_time > nowTime)
    .map((b) => ({
      eventName: b.event_name,
      startTime: b.start_time,
      endTime: b.end_time,
      status: b.start_time <= nowTime ? ('ongoing' as const) : ('upcoming' as const),
    }));

  const totalToday = all.length;
  let message: string | null = null;
  if (totalToday === 0) message = '本日の予約はありません';
  else if (bookings.length === 0) message = '本日の予約は全て終了しました';

  return c.json({
    spaceId,
    spaceName: space.name,
    date,
    now: nowTime,
    bookings,
    message,
  });
});

export default app;
