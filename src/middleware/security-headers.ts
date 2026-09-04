import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../types';

/**
 * セキュリティレスポンスヘッダを全応答に付与する（個人情報保護の多層防御）。
 *
 * 本システムの特性：
 *  - フロントは外部スクリプトを一切読み込まない（全JS/CSSは同一オリジンのインライン/静的）。
 *  - 決済はリダイレクト方式（Stripe Checkout / PayPal 承認URLへ画面遷移）で、
 *    決済事業者のスクリプトやiframeを埋め込まない。
 *  → よって CSP は比較的厳しめに設定できる（script/style はインライン多用のため 'unsafe-inline' のみ許容）。
 *
 * 例外：埋め込みカレンダー（/embed/calendar）だけは公式サイト等から iframe 設置されるため、
 *   frame-ancestors を緩め（*）、X-Frame-Options は付与しない。それ以外は SAMEORIGIN で
 *   クリックジャッキングを防ぐ。
 */

const EMBED_PATHS = new Set(['/embed/calendar', '/embed/calendar/']);

/** Content-Security-Policy を組み立てる。embed=true のページは他ドメインからのframeを許可。 */
export function buildCsp(embed: boolean): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // 外部スクリプトは Cloudflare Turnstile（CAPTCHA）のみ許可。他はインライン（'unsafe-inline'）。
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    // スペース画像は管理画面で外部URLを設定できるため https を許可。
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    // ブラウザからのfetchは同一オリジンの /api のみ（決済はサーバ側 or 画面遷移）。Turnstile検証は許可。
    "connect-src 'self' https://challenges.cloudflare.com",
    // Turnstile はウィジェットを iframe で表示する。
    "frame-src 'self' https://challenges.cloudflare.com",
    "form-action 'self'",
    embed ? 'frame-ancestors *' : "frame-ancestors 'self'",
  ].join('; ');
}

export const securityHeaders: MiddlewareHandler<AppBindings> = async (c, next) => {
  await next();

  const path = new URL(c.req.url).pathname;
  const embed = EMBED_PATHS.has(path);
  const csp = buildCsp(embed);

  const apply = (res: Response) => {
    res.headers.set('Content-Security-Policy', csp);
    // HTTPS強制の記憶（1年・このホストのサブドメイン含む）。Cloudflare側の Always Use HTTPS と併用。
    res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.headers.set('X-Content-Type-Options', 'nosniff');
    res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), browsing-topics=()');
    if (!embed) res.headers.set('X-Frame-Options', 'SAMEORIGIN');
  };

  try {
    apply(c.res);
  } catch {
    // ASSETS 応答などヘッダが不変（immutable）な場合は作り直して付与する
    const res = new Response(c.res.body, c.res);
    apply(res);
    c.res = res;
  }
};
