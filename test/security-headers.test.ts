import { describe, it, expect } from 'vitest';
import { buildCsp } from '../src/middleware/security-headers';

describe('buildCsp（Content-Security-Policy 生成）', () => {
  it('通常ページは frame-ancestors を自オリジンに限定（クリックジャッキング対策）', () => {
    const csp = buildCsp(false);
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain('frame-ancestors *');
  });
  it('埋め込みカレンダーは他ドメインからの frame を許可', () => {
    const csp = buildCsp(true);
    expect(csp).toContain('frame-ancestors *');
  });
  it('script-src は self・unsafe-inline・Turnstile のみ（他の外部スクリプトは不許可）', () => {
    const csp = buildCsp(false);
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com");
    // Turnstile 以外の https オリジンを script-src に含めない
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) || '';
    const externals = scriptSrc.match(/https?:\/\/[^\s]+/g) || [];
    expect(externals).toEqual(['https://challenges.cloudflare.com']);
  });
  it('object-src none / base-uri self を含む', () => {
    const csp = buildCsp(false);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
  it('ブラウザからの通信は同一オリジンのみ（connect-src self）', () => {
    expect(buildCsp(false)).toContain("connect-src 'self'");
  });
});
