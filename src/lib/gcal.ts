/**
 * Google カレンダー連携（サービスアカウント認証）。
 *
 * 設計（#25/#26/#27）:
 *  - 予約台帳の“正”は Google カレンダー（部屋ごとに1カレンダー）。
 *  - 予約確定時に freeBusy で空き照会 → events.insert（成立の瞬間）。
 *  - GOOGLE_SA_EMAIL と GOOGLE_SA_PRIVATE_KEY の両方が設定されているときのみ有効。
 *    未設定なら gcalConfigured=false（連携なしで従来通り動作）。
 *
 * 認証はサービスアカウントの JWT(RS256) を Google の token エンドポイントで
 * アクセストークンに交換する方式（Cloudflare Workers の WebCrypto で署名）。
 */

export interface GcalEnv {
  GOOGLE_SA_EMAIL?: string;
  GOOGLE_SA_PRIVATE_KEY?: string;
}

/** 連携が設定済みか（両方セット時のみ有効） */
export function gcalConfigured(env: GcalEnv): boolean {
  return !!(env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_PRIVATE_KEY);
}

export interface BusyInterval {
  start: string; // RFC3339
  end: string;
}

// --- 純粋ヘルパー（テスト可能） ---

/** 'YYYY-MM-DD' + 'HH:MM'（JST）を RFC3339（+09:00）に変換 */
export function toJstRfc3339(date: string, time: string): string {
  return `${date}T${time.length === 5 ? time : time.slice(0, 5)}:00+09:00`;
}

/** RFC3339（任意TZ）を JST の { date:'YYYY-MM-DD', time:'HH:MM' } に変換 */
export function rfc3339ToJst(iso: string): { date: string; time: string } {
  const d = new Date(Date.parse(iso) + 9 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

/**
 * busy 区間を対象日の HH:MM 区間にクランプして返す（対象日と重ならなければ null）。
 * 前日以前から続く場合は '00:00'、翌日以降まで続く場合は endBound（営業終了等）に丸める。
 */
export function busyToDayInterval(
  busy: BusyInterval,
  date: string,
  endBound: string,
): { startTime: string; endTime: string } | null {
  const s = rfc3339ToJst(busy.start);
  const e = rfc3339ToJst(busy.end);
  if (e.date < date || s.date > date) return null; // 対象日に無い
  // 終了が対象日の 00:00（＝前日で閉じる）は対象外
  if (e.date === date && e.time === '00:00') return null;
  const startTime = s.date < date ? '00:00' : s.time;
  const endTime = e.date > date ? endBound : e.time;
  if (startTime >= endTime) return null;
  return { startTime, endTime };
}

/** [aStart,aEnd) と [bStart,bEnd) が重なるか（RFC3339 文字列を時刻比較） */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const a1 = Date.parse(aStart), a2 = Date.parse(aEnd);
  const b1 = Date.parse(bStart), b2 = Date.parse(bEnd);
  return a1 < b2 && b1 < a2;
}

/** 要求時間帯が busy 群のいずれかと重なるか */
export function conflictsWithBusy(startISO: string, endISO: string, busy: readonly BusyInterval[]): boolean {
  return busy.some((b) => rangesOverlap(startISO, endISO, b.start, b.end));
}

// --- 認証 ---

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlStr(s: string): string {
  return base64url(new TextEncoder().encode(s));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // PEM の改行が \n 文字列で渡される場合に備えて復元
  const normalized = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  const body = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

// アクセストークンのメモリキャッシュ（同一 isolate 内で再利用）
let tokenCache: { token: string; exp: number } | null = null;

async function getAccessToken(env: GcalEnv): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp - 60 > nowSec) return tokenCache.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.GOOGLE_SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned = `${base64urlStr(JSON.stringify(header))}.${base64urlStr(JSON.stringify(claim))}`;
  const key = await importPrivateKey(env.GOOGLE_SA_PRIVATE_KEY!);
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${base64url(new Uint8Array(sig))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    throw new Error(`google token error: ${res.status} ${j.error ?? ''} ${j.error_description ?? ''}`);
  }
  tokenCache = { token: j.access_token, exp: nowSec + 3600 };
  return j.access_token;
}

// --- カレンダー操作 ---

/** 指定カレンダーの busy 時間帯を取得 */
export async function freeBusy(
  env: GcalEnv,
  calendarId: string,
  timeMinISO: string,
  timeMaxISO: string,
): Promise<BusyInterval[]> {
  const token = await getAccessToken(env);
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: timeMinISO, timeMax: timeMaxISO, timeZone: 'Asia/Tokyo', items: [{ id: calendarId }] }),
  });
  const j = (await res.json().catch(() => ({}))) as {
    calendars?: Record<string, { busy?: BusyInterval[]; errors?: unknown[] }>;
    error?: unknown;
  };
  if (!res.ok) throw new Error(`freeBusy error: ${res.status} ${JSON.stringify(j.error ?? j)}`);
  const cal = j.calendars?.[calendarId];
  if (cal?.errors?.length) throw new Error(`freeBusy calendar error: ${JSON.stringify(cal.errors)}`);
  return cal?.busy ?? [];
}

export interface CalendarEventInput {
  summary: string;
  description?: string;
  startISO: string; // RFC3339 (+09:00)
  endISO: string;
}

export interface CalendarEventResult {
  id: string;
  htmlLink?: string;
  created?: string;
}

/** イベントを作成（予約成立の“本体”） */
export async function insertEvent(
  env: GcalEnv,
  calendarId: string,
  ev: CalendarEventInput,
): Promise<CalendarEventResult> {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: ev.summary,
        description: ev.description ?? '',
        start: { dateTime: ev.startISO, timeZone: 'Asia/Tokyo' },
        end: { dateTime: ev.endISO, timeZone: 'Asia/Tokyo' },
      }),
    },
  );
  const j = (await res.json().catch(() => ({}))) as { id?: string; htmlLink?: string; created?: string; error?: unknown };
  if (!res.ok || !j.id) throw new Error(`insertEvent error: ${res.status} ${JSON.stringify(j.error ?? j)}`);
  return { id: j.id, htmlLink: j.htmlLink, created: j.created };
}

/** イベントのタイトル（summary）を更新（商談中→本予約化などの表示切替用） */
export async function patchEventSummary(
  env: GcalEnv,
  calendarId: string,
  eventId: string,
  summary: string,
): Promise<void> {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary }),
    },
  );
  if (!res.ok) throw new Error(`patchEvent error: ${res.status}`);
}

/** イベントのタイトル・説明を更新（内容リッチ化・支払い状況の反映用） */
export async function patchEventContent(
  env: GcalEnv,
  calendarId: string,
  eventId: string,
  fields: { summary: string; description: string },
): Promise<void> {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: fields.summary, description: fields.description }),
    },
  );
  if (!res.ok) throw new Error(`patchEventContent error: ${res.status}`);
}

/** イベントを削除（ロールバック・キャンセル用） */
export async function deleteEvent(env: GcalEnv, calendarId: string, eventId: string): Promise<void> {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  // 204 = 成功, 410 = 既に削除済み（許容）
  if (!res.ok && res.status !== 410) {
    throw new Error(`deleteEvent error: ${res.status}`);
  }
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  start: string; // RFC3339
  end: string;
  created?: string;
}

/** 期間内のイベント一覧（予約重複の再確認・照合用）。終日/キャンセル済みは除外 */
export async function listEvents(
  env: GcalEnv,
  calendarId: string,
  timeMinISO: string,
  timeMaxISO: string,
): Promise<CalendarEvent[]> {
  const token = await getAccessToken(env);
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('timeMin', timeMinISO);
  url.searchParams.set('timeMax', timeMaxISO);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('showDeleted', 'false');
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const j = (await res.json().catch(() => ({}))) as {
    items?: Array<{ id: string; status?: string; summary?: string; created?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }>;
    error?: unknown;
  };
  if (!res.ok) throw new Error(`listEvents error: ${res.status} ${JSON.stringify(j.error ?? j)}`);
  return (j.items ?? [])
    .filter((e) => e.status !== 'cancelled' && e.start?.dateTime && e.end?.dateTime)
    .map((e) => ({ id: e.id, summary: e.summary, start: e.start!.dateTime!, end: e.end!.dateTime!, created: e.created }));
}
