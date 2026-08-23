import { describe, it, expect } from 'vitest';
import { lineConfigured, buildLineAuthUrl } from '../src/lib/line-oauth';

describe('lineConfigured', () => {
  it('CHANNEL_ID と CHANNEL_SECRET が両方あるときのみ true', () => {
    expect(lineConfigured({})).toBe(false);
    expect(lineConfigured({ LINE_CHANNEL_ID: '123' })).toBe(false);
    expect(lineConfigured({ LINE_CHANNEL_SECRET: 'secret' })).toBe(false);
    expect(lineConfigured({ LINE_CHANNEL_ID: '  ', LINE_CHANNEL_SECRET: 'secret' })).toBe(false);
    expect(lineConfigured({ LINE_CHANNEL_ID: '123', LINE_CHANNEL_SECRET: 'secret' })).toBe(true);
  });
});

describe('buildLineAuthUrl', () => {
  it('LINEの認可エンドポイントと必須パラメータを含む', () => {
    const url = buildLineAuthUrl({
      clientId: '2000000001',
      redirectUri: 'https://booking.space-albe.com/api/auth/line/callback',
      state: 'st-123',
    });
    expect(url.startsWith('https://access.line.me/oauth2/v2.1/authorize?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('2000000001');
    expect(q.get('redirect_uri')).toBe('https://booking.space-albe.com/api/auth/line/callback');
    expect(q.get('state')).toBe('st-123');
    // メール取得のため email スコープを含む（openid/profile も）
    expect(q.get('scope')).toContain('email');
    expect(q.get('scope')).toContain('openid');
  });
});
