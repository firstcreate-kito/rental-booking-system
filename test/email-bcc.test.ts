import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendEmail } from '../src/lib/email';

// #106 お客様宛メールの控え（エビデンス）BCC複製の検証。
// sendEmail は Resend API を fetch で叩くため、fetch をスタブしてペイロードの bcc を検査する。
const BASE = { RESEND_API_KEY: 'k', MAIL_FROM: 'noreply@space-albe.com' } as const;

let lastBody: any = null;
beforeEach(() => {
  lastBody = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: any) => {
      lastBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('#106 控えBCC（お客様宛のみミラー）', () => {
  it('お客様宛メールは MAIL_BCC に複製される', async () => {
    const r = await sendEmail(
      { ...BASE, MAIL_BCC: 'rental-test@space-albe.com' },
      { to: 'customer@example.com', subject: 's', html: 'h', text: 't' },
    );
    expect(r.ok).toBe(true);
    expect(lastBody.bcc).toEqual(['rental-test@space-albe.com']);
    expect(lastBody.to).toEqual(['customer@example.com']);
  });

  it('MAIL_BCC 未設定なら bcc は付かない', async () => {
    await sendEmail(BASE, { to: 'customer@example.com', subject: 's', html: 'h', text: 't' });
    expect(lastBody.bcc).toBeUndefined();
  });

  it('internal:true（認証系など）は複製しない', async () => {
    await sendEmail(
      { ...BASE, MAIL_BCC: 'rental-test@space-albe.com' },
      { to: 'customer@example.com', subject: 's', html: 'h', text: 't', internal: true },
    );
    expect(lastBody.bcc).toBeUndefined();
  });

  it('宛先に MAIL_ADMIN を含む＝管理者宛の内部通知は複製しない', async () => {
    await sendEmail(
      { ...BASE, MAIL_BCC: 'rental-test@space-albe.com', MAIL_ADMIN: 'rental@space-albe.com' },
      { to: ['rental@space-albe.com', 'space-owner@example.com'], subject: 's', html: 'h', text: 't' },
    );
    expect(lastBody.bcc).toBeUndefined();
  });

  it('BCC先が既に宛先に入っている場合は二重送信しない（bccから除外）', async () => {
    await sendEmail(
      { ...BASE, MAIL_BCC: 'rental-test@space-albe.com' },
      { to: 'rental-test@space-albe.com', subject: 's', html: 'h', text: 't' },
    );
    expect(lastBody.bcc).toBeUndefined();
  });

  it('カンマ区切りで複数のBCC先に対応', async () => {
    await sendEmail(
      { ...BASE, MAIL_BCC: 'a@space-albe.com, b@space-albe.com' },
      { to: 'customer@example.com', subject: 's', html: 'h', text: 't' },
    );
    expect(lastBody.bcc).toEqual(['a@space-albe.com', 'b@space-albe.com']);
  });

  it('ステージングは実送信自体を停止（BCCも飛ばない）', async () => {
    const r = await sendEmail(
      { ...BASE, APP_ENV: 'staging', MAIL_BCC: 'rental-test@space-albe.com' },
      { to: 'customer@example.com', subject: 's', html: 'h', text: 't' },
    );
    expect(r.skipped).toBe(true);
    expect(lastBody).toBeNull(); // fetch は呼ばれない
  });
});
