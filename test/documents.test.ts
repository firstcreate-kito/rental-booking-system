import { describe, it, expect } from 'vitest';
import { taxBreakdown, renderDocumentHtml, type DocumentData } from '../src/lib/documents';

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
