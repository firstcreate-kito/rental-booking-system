import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, generateToken, isValidEmail } from '../src/lib/auth';

describe('password hashing (PBKDF2)', () => {
  it('正しいパスワードは検証成功', async () => {
    const stored = await hashPassword('SuperSecret123');
    expect(stored.startsWith('pbkdf2$')).toBe(true);
    expect(await verifyPassword('SuperSecret123', stored)).toBe(true);
  });

  it('誤ったパスワードは検証失敗', async () => {
    const stored = await hashPassword('SuperSecret123');
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('同じパスワードでもソルトで異なるハッシュになる', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('壊れた形式は失敗', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false);
  });
});

describe('generateToken', () => {
  it('64桁の16進、毎回異なる', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('isValidEmail', () => {
  it('妥当/不正を判定', () => {
    expect(isValidEmail('a@b.com')).toBe(true);
    expect(isValidEmail('bad')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
  });
});
