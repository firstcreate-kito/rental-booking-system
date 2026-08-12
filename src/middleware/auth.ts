import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../types';
import { getSessionCustomer, deleteSession } from '../db/repository';
import { nowJST } from '../lib/clock';

/** Authorization: Bearer <token> または Cookie(session) からトークンを取得 */
function extractToken(c: Parameters<MiddlewareHandler>[0]): string | null {
  const auth = c.req.header('Authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = c.req.header('Cookie');
  if (cookie) {
    const m = /(?:^|;\s*)session=([^;]+)/.exec(cookie);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

/** ログイン必須ミドルウェア。認証済みなら c.get('customer') が使える */
export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: 'ログインが必要です' }, 401);

  const session = await getSessionCustomer(c.env.DB, token);
  if (!session) return c.json({ error: 'セッションが無効です' }, 401);

  // 有効期限切れ
  if (session.expires_at <= nowJST()) {
    await deleteSession(c.env.DB, token);
    return c.json({ error: 'セッションの有効期限が切れました' }, 401);
  }

  // ブロック済み顧客は拒否
  if (session.is_blocked) {
    return c.json({ error: 'このアカウントはご利用いただけません' }, 403);
  }

  c.set('customer', {
    id: session.id,
    email: session.email,
    contactName: session.contact_name,
    statusId: session.status_id,
    isRegistered: !!session.is_registered,
  });
  await next();
};
