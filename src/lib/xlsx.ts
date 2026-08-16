/**
 * 依存ライブラリなしの最小 .xlsx 生成（#71）。
 * Cloudflare Workers（Node API なし）で確実に動くよう、OOXML(SpreadsheetML) を組み立て、
 * ZIP は無圧縮（STORE 方式・CRC32 のみ）でパッケージする。Excel でそのまま開ける。
 *
 * 文字列は inlineStr（sharedStrings を使わない）でシンプルに、数値は数値セルで出力する。
 */

export type Cell = string | number | null | undefined;
export interface Sheet {
  /** シート名（Excelの制約: 31文字以内・ : \ / ? * [ ] を含めない） */
  name: string;
  /** 1行目はヘッダー想定。行×列の二次元配列。 */
  rows: Cell[][];
}

const enc = new TextEncoder();

/** XML特殊文字と制御文字をエスケープ（制御文字はExcelが壊れるため除去） */
function xmlEscape(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 0基点の列番号を Excel の列記号（A, B, ... Z, AA, ...）に変換 */
function colLetter(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Excelのシート名として安全な形に整える（31文字・禁止文字除去） */
function safeSheetName(name: string, fallback: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31);
  return cleaned || fallback;
}

function sheetXml(sheet: Sheet): string {
  const rowsXml = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const ref = `${colLetter(c)}${r + 1}`;
          if (cell === null || cell === undefined || cell === '') return '';
          if (typeof cell === 'number' && Number.isFinite(cell)) {
            return `<c r="${ref}"><v>${cell}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(cell))}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rowsXml}</sheetData></worksheet>`
  );
}

// --- CRC32（ZIP用） ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/** 無圧縮ZIP（STORE）を組み立てて Uint8Array で返す */
function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;
  const push = (u: Uint8Array) => {
    chunks.push(u);
    offset += u.length;
  };
  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const localOffset = offset;
    // ローカルファイルヘッダ
    push(u32(0x04034b50));
    push(u16(20)); // version needed
    push(u16(0)); // flags
    push(u16(0)); // method = store
    push(u16(0)); // mod time
    push(u16(0)); // mod date
    push(u32(crc));
    push(u32(f.data.length)); // comp size
    push(u32(f.data.length)); // uncomp size
    push(u16(nameBytes.length));
    push(u16(0)); // extra len
    push(nameBytes);
    push(f.data);
    entries.push({ name: f.name, data: f.data, crc, offset: localOffset });
  }

  const centralStart = offset;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    push(u32(0x02014b50));
    push(u16(20)); // version made by
    push(u16(20)); // version needed
    push(u16(0)); // flags
    push(u16(0)); // method
    push(u16(0)); // time
    push(u16(0)); // date
    push(u32(e.crc));
    push(u32(e.data.length));
    push(u32(e.data.length));
    push(u16(nameBytes.length));
    push(u16(0)); // extra
    push(u16(0)); // comment
    push(u16(0)); // disk number
    push(u16(0)); // internal attrs
    push(u32(0)); // external attrs
    push(u32(e.offset)); // local header offset
    push(nameBytes);
  }
  const centralSize = offset - centralStart;

  // End of central directory
  push(u32(0x06054b50));
  push(u16(0)); // disk
  push(u16(0)); // disk with central dir
  push(u16(entries.length));
  push(u16(entries.length));
  push(u32(centralSize));
  push(u32(centralStart));
  push(u16(0)); // comment len

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** シート群から .xlsx バイト列を生成する */
export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const list = sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }];
  const files: Array<{ name: string; data: Uint8Array }> = [];

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    list
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '</Types>';
  files.push({ name: '[Content_Types].xml', data: enc.encode(contentTypes) });

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  files.push({ name: '_rels/.rels', data: enc.encode(rootRels) });

  const sheetsXml = list
    .map((s, i) => `<sheet name="${xmlEscape(safeSheetName(s.name, `Sheet${i + 1}`))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheetsXml}</sheets></workbook>`;
  files.push({ name: 'xl/workbook.xml', data: enc.encode(workbook) });

  const wbRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    list
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    '</Relationships>';
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) });

  list.forEach((s, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s)) });
  });

  return zipStore(files);
}
