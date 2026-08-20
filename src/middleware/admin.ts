import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../types';
import { getAdminSession, deleteAdminSession, touchAdminSession } from '../db/repository';
import { nowJST } from '../lib/clock';
import { sessionExpiry, ADMIN_SESSION_IDLE_MINUTES } from '../lib/auth';

function extractToken(authHeader?: string): string | null {
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  return null;
}

/** 管理者ログイン必須ミドルウェア */
export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = extractToken(c.req.header('Authorization'));
  if (!token) return c.json({ error: '管理者ログインが必要です' }, 401);

  const session = await getAdminSession(c.env.DB, token);
  if (!session) return c.json({ error: 'セッションが無効です' }, 401);
  if (session.expires_at <= nowJST()) {
    await deleteAdminSession(c.env.DB, token);
    return c.json({ error: 'セッションの有効期限が切れました' }, 401);
  }
  if (!session.is_active) return c.json({ error: 'この管理者アカウントは無効です' }, 403);

  // アイドルタイムアウトを延長（スライディング）: 操作のたびに現在時刻＋アイドル分へ更新
  await touchAdminSession(c.env.DB, token, sessionExpiry(ADMIN_SESSION_IDLE_MINUTES));

  c.set('admin', {
    id: session.id,
    email: session.email,
    name: session.name,
    role: session.role as 'owner' | 'manager' | 'staff',
  });
  await next();
};

/** 特定ロール以上を要求するミドルウェア生成 */
export function requireRole(...roles: Array<'owner' | 'manager' | 'staff'>): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const admin = c.get('admin');
    if (!admin || !roles.includes(admin.role)) {
      return c.json({ error: 'この操作を行う権限がありません' }, 403);
    }
    await next();
  };
}
