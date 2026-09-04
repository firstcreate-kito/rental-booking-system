/**
 * Cloudflare Turnstile（無料CAPTCHA）検証。
 * ボット・クレデンシャルスタッフィング・スパム対策として、ログイン等のフォームで使う。
 *
 * 有効化条件：Worker に TURNSTILE_SECRET_KEY が設定されているときだけ検証を強制する
 *   （未設定なら素通り＝段階導入できる。フロントの表示は TURNSTILE_SITE_KEY で制御）。
 */

interface TurnstileEnv {
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
}

/** Turnstile 検証を強制するか（シークレットが設定済みか） */
export function turnstileEnabled(env: TurnstileEnv): boolean {
  return !!env.TURNSTILE_SECRET_KEY;
}

/** フロントに渡す公開サイトキー（未設定なら空） */
export function turnstileSiteKey(env: TurnstileEnv): string {
  return env.TURNSTILE_SITE_KEY || '';
}

/**
 * Turnstile トークンを検証する。有効化されていなければ常に true（素通り）。
 * @param token フロントの cf-turnstile-response
 * @param ip    CF-Connecting-IP（任意）
 */
export async function verifyTurnstile(env: TurnstileEnv, token: string, ip?: string): Promise<boolean> {
  if (!turnstileEnabled(env)) return true; // 未設定時は検証しない
  if (!token) return false;
  try {
    const form = new URLSearchParams();
    form.set('secret', env.TURNSTILE_SECRET_KEY as string);
    form.set('response', token);
    if (ip) form.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const json = (await res.json()) as { success?: boolean };
    return !!json.success;
  } catch {
    // 検証サービスに到達できない場合は安全側で不許可
    return false;
  }
}
