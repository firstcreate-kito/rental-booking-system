import { describe, it, expect } from 'vitest';
import {
  sendEmail,
  escapeHtml,
  bookingConfirmationEmail,
  cancellationEmail,
  adminNewBookingEmail,
  rescheduleEmail,
  adminRescheduleEmail,
} from '../src/lib/email';

const sampleDays = [{ date: '2026-09-10', startTime: '10:00', endTime: '13:00' }];

describe('email - sendEmail の有効化条件', () => {
  it('APIキー未設定なら送信せず skipped', async () => {
    const r = await sendEmail({ MAIL_FROM: 'a@b.jp' }, { to: 'x@y.jp', subject: 's', html: 'h', text: 't' });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
  });
  it('MAIL_FROM 未設定なら送信せず skipped', async () => {
    const r = await sendEmail({ RESEND_API_KEY: 'k' }, { to: 'x@y.jp', subject: 's', html: 'h', text: 't' });
    expect(r.skipped).toBe(true);
  });
});

describe('email - escapeHtml', () => {
  it('特殊文字をエスケープ', () => {
    expect(escapeHtml('<b>"A&B"</b>')).toBe('&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;');
  });
});

describe('email - 予約確認テンプレート', () => {
  it('本予約: 予約番号・金額・日時を含む', () => {
    const m = bookingConfirmationEmail({
      bookingNumber: '20260910-001',
      spaceName: 'アルベホール名古屋',
      eventName: 'セミナー',
      customerName: '山田太郎',
      days: sampleDays,
      total: 28314,
      status: 'confirmed',
    });
    expect(m.subject).toContain('20260910-001');
    expect(m.subject).toContain('ご予約');
    expect(m.text).toContain('¥28,314');
    expect(m.text).toContain('2026-09-10');
    expect(m.html).toContain('アルベホール名古屋');
  });
  it('HTMLは可変値をエスケープする', () => {
    const m = bookingConfirmationEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: '<script>x</script>', customerName: 'A&B',
      days: sampleDays, total: 1000, status: 'confirmed',
    });
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('A&amp;B');
    expect(m.html).not.toContain('<script>x</script>');
  });
  it('仮予約は件名が仮予約表記', () => {
    const m = bookingConfirmationEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      days: sampleDays, total: 1000, status: 'tentative',
    });
    expect(m.subject).toContain('仮予約');
  });
});

describe('email - キャンセル/管理者通知テンプレート', () => {
  it('キャンセル: 料金ありは金額表示', () => {
    const m = cancellationEmail({ bookingNumber: 'B1', spaceName: 'S', customerName: 'N', cancelFee: 5000 });
    expect(m.text).toContain('¥5,000');
  });
  it('キャンセル: 料金0は「発生しません」', () => {
    const m = cancellationEmail({ bookingNumber: 'B1', spaceName: 'S', customerName: 'N', cancelFee: 0 });
    expect(m.text).toContain('発生しません');
  });
  it('管理者通知: お客様の連絡先を含む', () => {
    const m = adminNewBookingEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      days: sampleDays, total: 1000, status: 'confirmed',
      customerEmail: 'c@d.jp', customerPhone: '09000000000',
    });
    expect(m.text).toContain('c@d.jp');
    expect(m.text).toContain('09000000000');
  });
});

describe('email - 日時変更（reschedule）テンプレート', () => {
  const oldDays = [{ date: '2026-09-10', startTime: '10:00', endTime: '12:00' }];
  const newDays = [{ date: '2026-09-15', startTime: '14:00', endTime: '17:00' }];
  it('本予約: 変更前後の日時と金額を含む', () => {
    const m = rescheduleEmail({
      bookingNumber: 'B1', spaceName: 'アルベホール', eventName: 'E', customerName: '山田',
      oldDays, newDays, total: 32670, status: 'confirmed', showAmount: true,
    });
    expect(m.subject).toContain('B1');
    expect(m.subject).toContain('日時を変更');
    expect(m.text).toContain('2026-09-10');
    expect(m.text).toContain('2026-09-15');
    expect(m.text).toContain('¥32,670');
  });
  it('商談中: 金額を表示しない（showAmount=false）', () => {
    const m = rescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays, total: 21780, status: 'tentative', showAmount: false,
    });
    expect(m.subject).toContain('仮予約');
    expect(m.text).not.toContain('¥21,780');
  });
  it('管理者通知: 連絡先と変更前後を含む', () => {
    const m = adminRescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays, total: 1000, status: 'confirmed', showAmount: true,
      customerEmail: 'c@d.jp', customerPhone: '09000000000',
    });
    expect(m.text).toContain('c@d.jp');
    expect(m.text).toContain('2026-09-10');
    expect(m.text).toContain('2026-09-15');
  });
});
