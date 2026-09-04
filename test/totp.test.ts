import { describe, it, expect } from 'vitest';
import { base32Encode, base32Decode, totpCodeAt, verifyTotp, generateTotpSecret, generateRecoveryCodes, hashRecoveryCode, otpauthUrl } from '../src/lib/totp';

// RFC 6238 テストベクタ用のシークレット（ASCII "12345678901234567890"）を Base32 化したもの
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'));

describe('base32', () => {
  it('encode→decode で元に戻る', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64, 32]);
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
  });
  it('ASCII "12345678901234567890" は既知の Base32 になる', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});

describe('TOTP（RFC 6238 テストベクタ・SHA1・6桁）', () => {
  // RFC 6238 Appendix B（SHA1）の8桁値の下6桁
  it('T=59s → 287082', async () => {
    expect(await totpCodeAt(RFC_SECRET, 59 * 1000)).toBe('287082');
  });
  it('T=1111111109 → 081804', async () => {
    expect(await totpCodeAt(RFC_SECRET, 1111111109 * 1000)).toBe('081804');
  });
  it('T=1234567890 → 005924', async () => {
    expect(await totpCodeAt(RFC_SECRET, 1234567890 * 1000)).toBe('005924');
  });
});

describe('verifyTotp', () => {
  it('正しいコードは通る', async () => {
    const at = 1111111109 * 1000;
    expect(await verifyTotp(RFC_SECRET, '081804', at)).toBe(true);
  });
  it('±1ステップの時刻ずれを吸収する', async () => {
    const at = 1111111109 * 1000;
    const code = await totpCodeAt(RFC_SECRET, at);
    // 25秒後（同ステップ内〜隣接）でも通る
    expect(await verifyTotp(RFC_SECRET, code, at + 25 * 1000)).toBe(true);
  });
  it('誤ったコード・桁不足は弾く', async () => {
    const at = 1111111109 * 1000;
    expect(await verifyTotp(RFC_SECRET, '000000', at)).toBe(false);
    expect(await verifyTotp(RFC_SECRET, '1234', at)).toBe(false);
    expect(await verifyTotp(RFC_SECRET, '', at)).toBe(false);
  });
});

describe('secret / otpauth / recovery', () => {
  it('generateTotpSecret は Base32 32文字（20バイト）', () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });
  it('otpauthUrl は必要パラメータを含む', () => {
    const url = otpauthUrl('GEZDGNBVGY3TQOJQ', 'admin@example.com');
    expect(url.startsWith('otpauth://totp/')).toBe(true);
    expect(url).toContain('secret=GEZDGNBVGY3TQOJQ');
    expect(url).toContain('digits=6');
    expect(url).toContain('period=30');
  });
  it('リカバリコードは8個・区切り付き・ハッシュは正規化して一致', async () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(codes[0]).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const h1 = await hashRecoveryCode(codes[0]);
    const h2 = await hashRecoveryCode(codes[0].toLowerCase().replace(/-/g, ' ')); // 表記ゆれでも同じハッシュ
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
