import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../types';

/** Authorization: Bearer <token> または Cookie(session) から会員セッショントークンを取得 */
function extractCustomerToken(c: Parameters<MiddlewareHandler<AppBindings>>[0]): string | null {
  const auth = c.req.header('Authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = c.req.header('Cookie');
  if (cookie) {
    const m = /(?:^|;\s*)session=([^;]+)/.exec(cookie);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * なりすまし閲覧（サポート用）の安全装置：閲覧専用セッションからの書き込みを一律で拒否する。
 *
 * ・管理者が発行した閲覧専用セッション（auth_sessions.readonly=1）で mutating リクエスト
 *   （POST/PUT/PATCH/DELETE）が来たら 403 で止める。＝顧客になりすまして予約確定・決済・
 *   パスワード変更などを誤って行うことを防ぐ（UIのバナーが失敗してもサーバ側で防御）。
 * ・GET等の読み取りは素通り（＝画面はそのまま確認できる）。
 * ・自分自身のログアウトだけは許可（閲覧セッションを終了できるようにするため）。
 * ・追加読み取りは mutating かつトークンを持つリクエストのときだけ発生（通常利用に影響しない）。
 * ・migrate 前など readonly 列が無い場合は素通り（既存機能を壊さない＝フェイルオープン）。
 *   なりすまし閲覧セッションはこの機能稼働後にのみ発行されるため、フェイルオープンでも安全。
 */
export const blockImpersonationWrites: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const path = new URL(c.req.url).pathname;
  // 閲覧セッション自身の終了（ログアウト）は許可
  if (path.endsWith('/api/auth/logout')) return next();

  const token = extractCustomerToken(c);
  if (!token) return next();

  try {
    const row = await c.env.DB.prepare('SELECT readonly FROM auth_sessions WHERE token = ?')
      .bind(token)
      .first<{ readonly: number }>();
    if (row && row.readonly) {
      return c.json(
        { error: '閲覧専用（サポート閲覧）モードのため、この操作はできません。実際のお手続きはお客様ご自身のログインで行ってください。' },
        403,
      );
    }
  } catch {
    // readonly 列が無い等の場合は素通り（既存機能優先）
  }
  return next();
};
