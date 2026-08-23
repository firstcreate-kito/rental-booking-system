/**
 * 認証まわりのコア（パスワードハッシュ・トークン・有効期限）
 * Cloudflare Workers の WebCrypto を使用（bcrypt非対応のため PBKDF2 を採用）。
 */
const PBKDF2_ITERATIONS = 100_000;

/**
 * セッションのアイドルタイムアウト（無操作で自動ログアウトするまでの分数）。
 * ログイン中はリクエストのたびに expires_at が現在時刻＋この分数へ延長される（スライディング）。
 * この分数だけ一切の操作が無いとセッションが失効する。
 * フロント（public/mypage.html・public/index.html・public/viewing.html・public/admin.html）の
 * アイドルタイマーもこの値に合わせること。
 *
 * 会員（顧客）は「予約→決済→マイページ」の外部決済往復や再訪でログインを保持したいので
 * 30日のスライディングとする（保存も localStorage）。共有PCでは手動ログアウトを案内する。
 * 管理者は従来どおり短め（30分）に保つ。
 */
export const CUSTOMER_SESSION_IDLE_MINUTES = 30 * 24 * 60; // 30日
export const ADMIN_SESSION_IDLE_MINUTES = 30;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function deriveHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** パスワードをハッシュ化。形式: 'pbkdf2$<iter>$<saltB64>$<hashB64>' */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveHash(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** 定数時間比較 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** パスワード検証 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = fromBase64(parts[2]);
  const expected = fromBase64(parts[3]);
  const actual = await deriveHash(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

/** セッショントークン（32バイトの16進） */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * セッション有効期限（JST基準の 'YYYY-MM-DD HH:MM:SS'）。
 * アイドルタイムアウト方式のため、ログイン時だけでなく認証済みリクエストのたびに
 * この関数で再計算し expires_at を更新（延長）する。
 * @param minutes 現在時刻から何分後に失効させるか（既定＝会員のアイドル時間）
 */
export function sessionExpiry(
  minutes: number = CUSTOMER_SESSION_IDLE_MINUTES,
  now: number = Date.now(),
): string {
  const d = new Date(now + 9 * 60 * 60 * 1000 + minutes * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** メール形式の簡易チェック */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
