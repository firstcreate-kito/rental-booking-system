/**
 * Googleログイン（OAuth 2.0 / OpenID Connect・Authorization Code フロー）。
 *
 * 使い方：
 *  1) buildGoogleAuthUrl で同意画面URLを作りリダイレクト
 *  2) Google が redirect_uri?code=… に戻す
 *  3) exchangeGoogleCode でコードをトークンに交換し、id_token からメール等を取り出す
 *
 * id_token はトークンエンドポイント（HTTPS・client_secret 認証）から直接取得するため、
 * 署名の再検証は必須ではない。念のため aud（client_id）・iss・exp は検証する。
 */
export interface GoogleEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export function googleConfigured(env: GoogleEnv): boolean {
  return !!(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}

export function buildGoogleAuthUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: p.state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString();
}

/** base64url の JWT ペイロードをデコードして JSON を返す。 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = decodeURIComponent(
      atob(b64)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  name: string;
}

/**
 * 認可コードをトークンに交換し、id_token から本人情報を取り出す。
 * 失敗時は { ok:false, error }。
 */
export async function exchangeGoogleCode(
  env: GoogleEnv,
  code: string,
  redirectUri: string,
): Promise<{ ok: true; identity: GoogleIdentity } | { ok: false; error: string }> {
  try {
    const body = new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const j = (await res.json()) as { id_token?: string; error_description?: string; error?: string };
    if (!res.ok || !j.id_token) return { ok: false, error: j.error_description || j.error || `token exchange failed (${res.status})` };
    const payload = decodeJwtPayload(j.id_token);
    if (!payload) return { ok: false, error: 'id_token decode failed' };
    // aud / iss / exp の最小検証
    if (payload.aud !== env.GOOGLE_CLIENT_ID) return { ok: false, error: 'aud mismatch' };
    const iss = String(payload.iss || '');
    if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') return { ok: false, error: 'iss mismatch' };
    const exp = Number(payload.exp || 0);
    if (!exp || exp * 1000 < Date.now()) return { ok: false, error: 'id_token expired' };
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email) return { ok: false, error: 'email not present' };
    return {
      ok: true,
      identity: { email, emailVerified: payload.email_verified === true, name: String(payload.name || '') },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
