import { describe, it, expect } from 'vitest';
import { buildCsp, isEmbeddable } from '../src/middleware/security-headers';

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

describe('isEmbeddable（外部サイトからの iframe 許可判定）', () => {
  it('専用カレンダー /embed/calendar は ?embed 無しでも常に許可', () => {
    expect(isEmbeddable('/embed/calendar', false)).toBe(true);
    expect(isEmbeddable('/embed/calendar/', false)).toBe(true);
  });
  it('アプリ本体ルート / は ?embed=1 のときだけ許可（公式サイトの埋め込み）', () => {
    expect(isEmbeddable('/', true)).toBe(true);
    expect(isEmbeddable('/index.html', true)).toBe(true);
    expect(isEmbeddable('/', false)).toBe(false); // 通常アクセスはクリックジャッキング防止
  });
  it('空き状況ページ /availability も ?embed=1 で許可', () => {
    expect(isEmbeddable('/availability', true)).toBe(true);
    expect(isEmbeddable('/availability/', true)).toBe(true);
    expect(isEmbeddable('/availability/', false)).toBe(false);
  });
  it('会員・管理ページは ?embed=1 を付けても frame 許可しない（悪用対策）', () => {
    expect(isEmbeddable('/mypage', true)).toBe(false);
    expect(isEmbeddable('/admin', true)).toBe(false);
    expect(isEmbeddable('/tickets', true)).toBe(false);
    expect(isEmbeddable('/viewing', true)).toBe(false);
  });
});
