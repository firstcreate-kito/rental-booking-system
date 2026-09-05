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
 * 例外：外部サイト（公式サイト space-albe.com 等）から iframe 設置される埋め込み面だけは
 *   frame-ancestors を緩め（*）、X-Frame-Options は付与しない。それ以外は SAMEORIGIN で
 *   クリックジャッキングを防ぐ。埋め込み面は次の2種類：
 *     (1) 専用カレンダー … /embed/calendar（常に埋め込み用）。
 *     (2) 予約アプリ本体・空き状況ページを ?embed=1 で開いたもの
 *         （公式サイトは / を ?space=…&embed=1 で iframe 設置。埋め込み時はヘッダー非表示・
 *          日付クリックや決済は window.top で全画面遷移する設計）。
 *   ※ (2) はパスを公開ページ（/・/availability）に限定する。?embed=1 を付けるだけで
 *      /mypage や /admin まで frame 許可されると、クリックジャッキングの穴になるため。
 */

// 常に埋め込み用（読み取り専用カレンダー）
const EMBED_PATHS = new Set(['/embed/calendar', '/embed/calendar/']);
// ?embed=1 のときだけ埋め込みを許可する公開ページ（アプリ本体ルート・空き状況ページ）
const EMBEDDABLE_WITH_FLAG = new Set(['/', '/index.html', '/availability', '/availability/']);

/**
 * このリクエストのレスポンスを外部サイトから iframe 設置してよいか判定する。
 * - 専用カレンダー（/embed/calendar）は常に可。
 * - それ以外は「公開埋め込みページ」かつ ?embed=1 のときだけ可（/mypage・/admin 等は不可）。
 */
export function isEmbeddable(path: string, embedFlag: boolean): boolean {
  return EMBED_PATHS.has(path) || (embedFlag && EMBEDDABLE_WITH_FLAG.has(path));
}

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

  const url = new URL(c.req.url);
  const path = url.pathname;
  const embedFlag = url.searchParams.get('embed') === '1';
  const embed = isEmbeddable(path, embedFlag);
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
