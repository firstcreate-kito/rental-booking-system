import { describe, it, expect } from 'vitest';
import { normalizeEmail, normalizePhone, guestContactMatches } from '../src/lib/verify';

describe('verify - normalize（#75）', () => {
  it('email: 前後空白除去・小文字化', () => {
    expect(normalizeEmail('  Foo@Example.JP ')).toBe('foo@example.jp');
    expect(normalizeEmail(null)).toBe('');
  });
  it('phone: 全角→半角・数字以外除去', () => {
    expect(normalizePhone('090-1111-2222')).toBe('09011112222');
    expect(normalizePhone('０９０ー１１１１ー２２２２')).toBe('09011112222');
    expect(normalizePhone('(090) 1111 2222')).toBe('09011112222');
  });
});

describe('verify - guestContactMatches（#75）', () => {
  const stored = { email: 'guest@example.jp', phone: '090-1111-2222' };
  it('メール・電話が一致（表記ゆれ含む）→ true', () => {
    expect(guestContactMatches({ email: 'GUEST@example.jp', phone: '09011112222' }, stored)).toBe(true);
    expect(guestContactMatches({ email: ' guest@example.jp ', phone: '090-1111-2222' }, stored)).toBe(true);
  });
  it('メール不一致 → false', () => {
    expect(guestContactMatches({ email: 'other@example.jp', phone: '09011112222' }, stored)).toBe(false);
  });
  it('電話不一致 → false', () => {
    expect(guestContactMatches({ email: 'guest@example.jp', phone: '09099999999' }, stored)).toBe(false);
  });
  it('未入力・保存側欠落 → false', () => {
    expect(guestContactMatches({ email: '', phone: '' }, stored)).toBe(false);
    expect(guestContactMatches({ email: 'guest@example.jp', phone: '09011112222' }, { email: null, phone: null })).toBe(false);
  });
});
