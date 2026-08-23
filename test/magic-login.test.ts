import { describe, it, expect } from 'vitest';
import { magicLinkEmail, loginCodeEmail } from '../src/lib/email';

describe('magicLinkEmail', () => {
  it('ログインURLと有効期限を含む', () => {
    const m = magicLinkEmail({ loginUrl: 'https://booking.space-albe.com/mypage.html?magic=abc', expiresLabel: '30分' });
    expect(m.subject).toContain('ログイン');
    expect(m.text).toContain('https://booking.space-albe.com/mypage.html?magic=abc');
    expect(m.text).toContain('30分');
    expect(m.html).toContain('ログインする');
    expect(m.html).toContain('magic=abc');
  });
});

describe('loginCodeEmail', () => {
  it('6桁コードと有効期限を含む', () => {
    const m = loginCodeEmail({ code: '424749', expiresLabel: '10分' });
    expect(m.subject).toContain('424749');
    expect(m.text).toContain('424749');
    expect(m.text).toContain('10分');
    expect(m.html).toContain('424749');
  });
});
