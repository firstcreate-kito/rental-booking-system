/**
 * TOTP（時間ベースのワンタイムパスワード・RFC 6238）実装。
 * 管理者ログインの二段階認証（2FA）に使用。Cloudflare Workers の WebCrypto（HMAC-SHA1）で計算する。
 * 併せて、端末紛失時のためのリカバリコード（ワンタイム）も扱う。
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SEC = 30;
const DIGITS = 6;

/** バイト列を Base32（RFC4648・パディング無し）にエンコード */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Base32（大文字小文字・パディング・空白を許容）をデコード */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/,'').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue; // 不正文字は無視
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** ランダムな TOTP シークレット（20バイト）を Base32 で返す */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

async function hmacSha1(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, msg);
  return new Uint8Array(sig);
}

/** HOTP（カウンタベース・RFC4226）を DIGITS 桁で返す */
async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const buf = new Uint8Array(8);
  // 64bit big-endian（counter は 2^53 未満で十分。上位32bitと下位32bitに分割）
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  buf[0] = (high >>> 24) & 0xff;
  buf[1] = (high >>> 16) & 0xff;
  buf[2] = (high >>> 8) & 0xff;
  buf[3] = high & 0xff;
  buf[4] = (low >>> 24) & 0xff;
  buf[5] = (low >>> 16) & 0xff;
  buf[6] = (low >>> 8) & 0xff;
  buf[7] = low & 0xff;
  const h = await hmacSha1(secret, buf);
  const offset = h[h.length - 1] & 0x0f;
  const bin =
    ((h[offset] & 0x7f) << 24) |
    ((h[offset + 1] & 0xff) << 16) |
    ((h[offset + 2] & 0xff) << 8) |
    (h[offset + 3] & 0xff);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** 指定時刻（ms）の TOTP コードを返す */
export async function totpCodeAt(secretBase32: string, atMs: number): Promise<string> {
  const counter = Math.floor(atMs / 1000 / PERIOD_SEC);
  return hotp(base32Decode(secretBase32), counter);
}

/**
 * 入力コードを検証する。時刻ずれを吸収するため前後 window ステップ（既定±1＝±30秒）まで許容。
 * 6桁以外や空は即 false。
 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  atMs: number = Date.now(),
  window = 1,
): Promise<boolean> {
  const normalized = (code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const secret = base32Decode(secretBase32);
  const base = Math.floor(atMs / 1000 / PERIOD_SEC);
  for (let w = -window; w <= window; w++) {
    const candidate = await hotp(secret, base + w);
    // 桁数は固定なので単純比較で可（タイミング差はブルートフォース対策の回数制限側で担保）
    if (candidate === normalized) return true;
  }
  return false;
}

/** 認証アプリ登録用の otpauth URI を生成（QR/手動入力どちらにも使える） */
export function otpauthUrl(secretBase32: string, account: string, issuer = 'ALBE 予約管理'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// --- リカバリコード（端末紛失時のワンタイムコード） ---

/** 表示用に読みやすいリカバリコード（例: 4x4=16文字, ハイフン区切り）を n 個生成 */
export function generateRecoveryCodes(n = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = base32Encode(crypto.getRandomValues(new Uint8Array(10))).slice(0, 16);
    codes.push(raw.replace(/(.{4})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4'));
  }
  return codes;
}

/** リカバリコードを保存用にハッシュ化（高エントロピーのため SHA-256 で十分）。比較用に正規化する。 */
export async function hashRecoveryCode(code: string): Promise<string> {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
