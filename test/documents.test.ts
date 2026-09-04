import { describe, it, expect } from 'vitest';
import { taxBreakdown, renderDocumentHtml, pickRecipientName, pickRecipientHonorific, looksLikeOrganizationName, type DocumentData } from '../src/lib/documents';

describe('pickRecipientName（宛名の優先順・#41 A案）', () => {
  it('請求書宛名があれば最優先', () => {
    expect(pickRecipientName('株式会社ALBE（宛名）', '株式会社サンプル', '山田 太郎')).toBe('株式会社ALBE（宛名）');
  });
  it('請求書宛名が空なら会社名を使う（A案の要点）', () => {
    expect(pickRecipientName('', '株式会社サンプル', '山田 太郎')).toBe('株式会社サンプル');
    expect(pickRecipientName(null, '株式会社サンプル', '山田 太郎')).toBe('株式会社サンプル');
  });
  it('請求書宛名・会社名が空ならお名前を使う', () => {
    expect(pickRecipientName('', '', '山田 太郎')).toBe('山田 太郎');
    expect(pickRecipientName(null, null, '山田 太郎')).toBe('山田 太郎');
  });
  it('すべて空なら「お客様」', () => {
    expect(pickRecipientName('', '', '')).toBe('お客様');
    expect(pickRecipientName(null, null, null)).toBe('お客様');
  });
  it('前後の空白はトリムする', () => {
    expect(pickRecipientName('  ', '  株式会社サンプル  ', '山田 太郎')).toBe('株式会社サンプル');
  });
});

describe('pickRecipientHonorific（敬称の出し分け）', () => {
  it('お名前のみ（個人）は「様」', () => {
    expect(pickRecipientHonorific('', '', '山田 太郎')).toBe('様');
    expect(pickRecipientHonorific(null, null, '山田 太郎')).toBe('様');
  });
  it('会社名は「御中」', () => {
    expect(pickRecipientHonorific('', '株式会社サンプル', '山田 太郎')).toBe('御中');
  });
  it('宛名指定：会社を示す語を含めば「御中」', () => {
    expect(pickRecipientHonorific('株式会社ALBE', '', '')).toBe('御中');
    expect(pickRecipientHonorific('山田商店', '', '山田 太郎')).toBe('御中');
  });
  it('宛名指定：個人名なら「様」', () => {
    expect(pickRecipientHonorific('山田 太郎', '', '')).toBe('様');
    expect(pickRecipientHonorific('山田 太郎', '株式会社サンプル', '鈴木')).toBe('様'); // 宛名指定が最優先
  });
  it('どれも無い（お客様）は敬称なし', () => {
    expect(pickRecipientHonorific('', '', '')).toBe('');
  });
  it('looksLikeOrganizationName の判定', () => {
    expect(looksLikeOrganizationName('株式会社ALBE')).toBe(true);
    expect(looksLikeOrganizationName('有限会社サンプル')).toBe(true);
    expect(looksLikeOrganizationName('山田商店')).toBe(true);
    expect(looksLikeOrganizationName('ALBE Inc.')).toBe(true);
    expect(looksLikeOrganizationName('山田 太郎')).toBe(false);
    expect(looksLikeOrganizationName('田中花子')).toBe(false);
  });
});

describe('renderDocumentHtml 敬称', () => {
  it('個人（recipientHonorific=様）は「様」で表示', () => {
    const html = renderDocumentHtml({ ...base, recipientName: '山田 太郎', recipientHonorific: '様' });
    expect(html).toContain('山田 太郎 様');
    expect(html).not.toContain('山田 太郎 御中');
  });
  it('会社（recipientHonorific=御中）は「御中」で表示', () => {
    const html = renderDocumentHtml({ ...base, recipientName: '株式会社サンプル', recipientHonorific: '御中' });
    expect(html).toContain('株式会社サンプル 御中');
  });
  it('お客様（recipientHonorific=空）は敬称を付けない', () => {
    const html = renderDocumentHtml({ ...base, recipientName: 'お客様', recipientHonorific: '' });
    expect(html).toContain('お客様');
    expect(html).not.toContain('お客様 御中');
    expect(html).not.toContain('お客様 様');
  });
  it('recipientHonorific 未指定は従来どおり「御中」（後方互換）', () => {
    const html = renderDocumentHtml({ ...base, recipientName: '株式会社サンプル' });
    expect(html).toContain('株式会社サンプル 御中');
  });
});

describe('taxBreakdown', () => {
  it('税込から10%を割り戻す', () => {
    expect(taxBreakdown(11000)).toEqual({ net: 10000, tax: 1000, total: 11000 });
  });
  it('端数は四捨五入', () => {
    const b = taxBreakdown(9680);
    expect(b.total).toBe(9680);
    expect(b.tax).toBe(880); // 9680*10/110 = 880
    expect(b.net).toBe(8800);
  });
});

const base: DocumentData = {
  type: 'receipt',
  documentNumber: '20260825-007-RCP',
  issuedDate: '2026-08-25',
  bookingNumber: '20260825-007',
  recipientName: '株式会社サンプル',
  spaceName: '名駅フリースペース',
  eventName: 'ワークショップ',
  items: [{ date: '2026-08-25', startTime: '13:00', endTime: '15:00' }],
  total: 9680,
  paymentMethodLabel: 'クレジットカード等（Stripe）',
  issuer: { name: 'レンタルスペースALBE', invoiceRegNo: 'T1234567890123', bankInfo: 'ABC銀行 名駅支店 普通 1234567' },
};

describe('renderDocumentHtml', () => {
  it('領収書の主要項目を含む', () => {
    const html = renderDocumentHtml(base);
    expect(html).toContain('領収書');
    expect(html).toContain('株式会社サンプル 御中');
    expect(html).toContain('20260825-007');
    expect(html).toContain('¥9,680');
    expect(html).toContain('上記正に領収いたしました');
    expect(html).toContain('T1234567890123');
    expect(html).toContain('window.print()');
  });
  it('請求書は振込先を表示する', () => {
    const html = renderDocumentHtml({ ...base, type: 'invoice', documentNumber: '20260825-007-INV' });
    expect(html).toContain('請求書');
    expect(html).toContain('お振込先');
    expect(html).toContain('ABC銀行 名駅支店 普通 1234567');
  });
  it('HTMLエスケープされる（宛名にタグ）', () => {
    const html = renderDocumentHtml({ ...base, recipientName: '<script>x</script>' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('備考（remark）を指定すると領収書に表示される', () => {
    const html = renderDocumentHtml({ ...base, remark: '2026-09-17 追加分 ¥3,630 を反映しました。' });
    expect(html).toContain('備考');
    expect(html).toContain('2026-09-17 追加分 ¥3,630 を反映しました。');
  });
  it('備考なしのときは備考欄を出さない', () => {
    const html = renderDocumentHtml(base);
    expect(html).not.toContain('備考');
  });
});
