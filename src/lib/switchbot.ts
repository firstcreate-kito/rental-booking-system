/**
 * SwitchBot API v1.1 クライアント（署名認証つき）。
 * 予約連動のスマートロック解錠に使う。方針＝「解錠のみ」（施錠コマンドは送らない・A案）。
 *
 * 認証：Authorization=token, sign=Base64(HMAC-SHA256(secret, token+t+nonce)), t=ミリ秒, nonce=UUID。
 * トークン/シークレットは env（Cloudflare Secrets）に置く：SWITCHBOT_TOKEN / SWITCHBOT_SECRET。
 * ドキュメント：https://github.com/OpenWonderLabs/SwitchBotAPI
 */

const BASE_URL = 'https://api.switch-bot.com';

export interface SwitchBotEnv {
  SWITCHBOT_TOKEN?: string;
  SWITCHBOT_SECRET?: string;
}

/** トークン/シークレット両方が揃っているか。 */
export function switchbotConfigured(env: SwitchBotEnv): boolean {
  return !!(env.SWITCHBOT_TOKEN && env.SWITCHBOT_SECRET);
}

/** 認証ヘッダを生成（t/nonce/sign）。 */
async function authHeaders(token: string, secret: string): Promise<Record<string, string>> {
  const t = Date.now().toString();
  const nonce = crypto.randomUUID();
  const data = token + t + nonce;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sign = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return {
    Authorization: token,
    sign,
    nonce,
    t,
    'Content-Type': 'application/json; charset=utf8',
  };
}

export interface SwitchBotResult<T = unknown> {
  ok: boolean;
  statusCode: number; // SwitchBot の body.statusCode（100=成功）
  httpStatus: number; // HTTP ステータス
  message?: string;
  body?: T;
}

/** 共通リクエスト。SwitchBotは body.statusCode===100 が成功。 */
async function request<T = unknown>(env: SwitchBotEnv, method: 'GET' | 'POST', path: string, payload?: unknown): Promise<SwitchBotResult<T>> {
  if (!switchbotConfigured(env)) return { ok: false, statusCode: -1, httpStatus: 0, message: 'SwitchBot未設定' };
  const headers = await authHeaders(env.SWITCHBOT_TOKEN!, env.SWITCHBOT_SECRET!);
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  } catch (e) {
    return { ok: false, statusCode: -1, httpStatus: 0, message: `通信エラー: ${(e as Error).message}` };
  }
  let json: { statusCode?: number; message?: string; body?: T } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    /* JSONでない応答 */
  }
  const statusCode = typeof json.statusCode === 'number' ? json.statusCode : res.status;
  return {
    ok: res.ok && statusCode === 100,
    statusCode,
    httpStatus: res.status,
    message: json.message,
    body: json.body,
  };
}

export interface SwitchBotDevice {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  hubDeviceId?: string;
}

/** アカウント配下のデバイス一覧を取得（deviceId確認用）。 */
export async function listDevices(env: SwitchBotEnv): Promise<SwitchBotResult<{ deviceList: SwitchBotDevice[]; infraredRemoteList: SwitchBotDevice[] }>> {
  return request(env, 'GET', '/v1.1/devices');
}

/** デバイスの状態を取得（lockState/doorState/battery など）。 */
export async function getDeviceStatus(env: SwitchBotEnv, deviceId: string): Promise<SwitchBotResult<Record<string, unknown>>> {
  return request(env, 'GET', `/v1.1/devices/${encodeURIComponent(deviceId)}/status`);
}

/** コマンド送信。 */
export async function sendCommand(env: SwitchBotEnv, deviceId: string, command: string, parameter: string = 'default', commandType: string = 'command'): Promise<SwitchBotResult> {
  return request(env, 'POST', `/v1.1/devices/${encodeURIComponent(deviceId)}/commands`, { command, parameter, commandType });
}

/** ロックを解錠する（施錠はしない＝A案）。 */
export async function unlockLock(env: SwitchBotEnv, lockDeviceId: string): Promise<SwitchBotResult> {
  return sendCommand(env, lockDeviceId, 'unlock');
}
