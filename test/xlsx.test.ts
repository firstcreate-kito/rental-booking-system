import { describe, it, expect } from 'vitest';
import { buildXlsx } from '../src/lib/xlsx';

const decode = (u: Uint8Array) => new TextDecoder('utf-8').decode(u);

describe('xlsx - buildXlsx（#71 依存なし .xlsx 生成）', () => {
  it('ZIP署名(PK\\x03\\x04)で始まる', () => {
    const b = buildXlsx([{ name: 'S1', rows: [['a']] }]);
    expect(b[0]).toBe(0x50);
    expect(b[1]).toBe(0x4b);
    expect(b[2]).toBe(0x03);
    expect(b[3]).toBe(0x04);
  });

  it('必要なOOXMLパートを含む（無圧縮なので生バイトに現れる）', () => {
    const s = decode(buildXlsx([{ name: 'S1', rows: [['x']] }]));
    expect(s).toContain('[Content_Types].xml');
    expect(s).toContain('xl/workbook.xml');
    expect(s).toContain('xl/worksheets/sheet1.xml');
    expect(s).toContain('_rels/.rels');
  });

  it('文字列は inlineStr、数値は数値セルで出力', () => {
    const s = decode(buildXlsx([{ name: 'データ', rows: [['名前', '金額'], ['テスト太郎', 21780]] }]));
    expect(s).toContain('t="inlineStr"');
    expect(s).toContain('テスト太郎');
    expect(s).toContain('<v>21780</v>');
    // ヘッダー文字列
    expect(s).toContain('金額');
  });

  it('XML特殊文字をエスケープ', () => {
    const s = decode(buildXlsx([{ name: 'S', rows: [['<a>&"\'']] }]));
    expect(s).toContain('&lt;a&gt;&amp;&quot;&apos;');
  });

  it('複数シートに対応（シート名は31文字・禁止文字を除去）', () => {
    const s = decode(
      buildXlsx([
        { name: 'A/B:C', rows: [['1']] },
        { name: 'Sheet2', rows: [['2']] },
      ]),
    );
    expect(s).toContain('xl/worksheets/sheet2.xml');
    // 禁止文字 / : は空白に置換される
    expect(s).toContain('name="A B C"');
  });

  it('空データでも壊れない', () => {
    const b = buildXlsx([{ name: 'empty', rows: [] }]);
    expect(b.length).toBeGreaterThan(0);
    expect(b[0]).toBe(0x50);
  });
});
