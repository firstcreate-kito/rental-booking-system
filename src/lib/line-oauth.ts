/**
 * LINEログイン（LINE Login v2.1・OAuth 2.0 / OpenID Connect・Authorization Code フロー）。
 *
 * 使い方（Googleログインと同じ考え方）：
 *  1) buildLineAuthUrl で同意画面URLを作りリダイレクト
 *  2) LINE が redirect_uri?code=… に戻す
 *  3) exchangeLineCode でコードをトークンに交換し、id_token からメール等を取り出す
 *
 * id_token はトークンエンドポイント（HTTPS・channel secret 認証）から直接取得するため、
 * 署名の再検証は必須ではない。念のため aud（channel id）・iss・exp は検証する。
 *
 * メールアドレスは、LINE Developers で「メールアドレス取得権限」を申請・許可し、
 * かつ利用者が同意した場合のみ id_token に含まれる。含まれない場合はログイン不可として扱う。
 */
export interface LineEnv {
  LINE_CHANNEL_ID?: string;
  LINE_CHANNEL_SECRET?: string;
}

export function lineConfigured(env: LineEnv): boolean {
  return !!(env.LINE_CHANNEL_ID?.trim() && env.LINE_CHANNEL_SECRET?.trim());
}

export function buildLineAuthUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    state: p.state,
    scope: 'openid profile email',
    // 毎回アカウント選択（同意）画面を表示させ、別アカウントに切り替えやすくする
    prompt: 'consent',
  });
  return 'https://access.line.me/oauth2/v2.1/authorize?' + q.toString();
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

export interface LineIdentity {
  email: string;
  name: string;
}

/**
 * 認可コードをトークンに交換し、id_token から本人情報を取り出す。
 * 失敗時は { ok:false, error }。
 */
export async function exchangeLineCode(
  env: LineEnv,
  code: string,
  redirectUri: string,
): Promise<{ ok: true; identity: LineIdentity } | { ok: false; error: string }> {
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: env.LINE_CHANNEL_ID ?? '',
      client_secret: env.LINE_CHANNEL_SECRET ?? '',
    });
    const res = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const j = (await res.json()) as { id_token?: string; error_description?: string; error?: string };
    if (!res.ok || !j.id_token) return { ok: false, error: j.error_description || j.error || `token exchange failed (${res.status})` };
    const payload = decodeJwtPayload(j.id_token);
    if (!payload) return { ok: false, error: 'id_token decode failed' };
    // aud / iss / exp の最小検証（aud は文字列または配列のことがある）
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(env.LINE_CHANNEL_ID) : String(aud) === env.LINE_CHANNEL_ID;
    if (!audOk) return { ok: false, error: 'aud mismatch' };
    if (String(payload.iss || '') !== 'https://access.line.me') return { ok: false, error: 'iss mismatch' };
    const exp = Number(payload.exp || 0);
    if (!exp || exp * 1000 < Date.now()) return { ok: false, error: 'id_token expired' };
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email) return { ok: false, error: 'email not present' };
    return { ok: true, identity: { email, name: String(payload.name || '') } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
