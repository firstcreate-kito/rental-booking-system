import { describe, it, expect } from 'vitest';
import { resolveOauthReturn } from '../src/routes/auth';

describe('resolveOauthReturn (案A・#91 オープンリダイレクト防止)', () => {
  it('既知のキーだけを既定パスに解決する', () => {
    expect(resolveOauthReturn('booking')).toBe('/');
    expect(resolveOauthReturn('viewing')).toBe('/viewing.html');
    expect(resolveOauthReturn('mypage')).toBe('/mypage.html');
  });
  it('前後の空白は許容する', () => {
    expect(resolveOauthReturn(' booking ')).toBe('/');
  });
  it('未知・未指定・不正値はすべてマイページにフォールバック（外部URLに飛ばさない）', () => {
    expect(resolveOauthReturn('')).toBe('/mypage.html');
    expect(resolveOauthReturn(undefined)).toBe('/mypage.html');
    expect(resolveOauthReturn(null)).toBe('/mypage.html');
    expect(resolveOauthReturn('https://evil.example.com')).toBe('/mypage.html');
    expect(resolveOauthReturn('//evil.example.com')).toBe('/mypage.html');
    expect(resolveOauthReturn('/admin.html')).toBe('/mypage.html');
  });
});
