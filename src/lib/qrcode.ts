/**
 * 依存ライブラリ無しの QRコード生成（ISO/IEC 18004）。バイトモード・誤り訂正レベルM・
 * バージョン自動選択。2FA設定の otpauth URI を SVG で表示するために使う。
 *
 * アルゴリズムは Nayuki 氏の QR Code generator（パブリックドメイン）を TypeScript に
 * 忠実移植したもの。外部スクリプト/画像を読み込めない CSP 環境でも動くよう自前実装。
 */

// 誤り訂正レベル（今回は M 固定で使用）。値は [ordinal, formatBits]
const ECL_M = { ordinal: 1, formatBits: 0 } as const;

// バージョン1〜40 × ECC(L,M,Q,H) の1ブロックあたりECCコードワード数
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const MIN_VERSION = 1;
const MAX_VERSION = 40;

function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function getNumDataCodewords(ver: number, eclOrdinal: number): number {
  return (
    Math.floor(getNumRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[eclOrdinal][ver] * NUM_ERROR_CORRECTION_BLOCKS[eclOrdinal][ver]
  );
}

// --- Reed-Solomon (GF(256), primitive 0x11D) ---
function reedSolomonMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function reedSolomonComputeDivisor(degree: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < degree - 1; i++) result.push(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}
function reedSolomonComputeRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= reedSolomonMultiply(coef, factor)));
  }
  return result;
}

// --- ビットバッファ ---
function appendBits(val: number, len: number, bb: number[]): void {
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

/** バイトモードで text（UTF-8）をエンコードし、モジュール行列（boolean[][]）を返す。 */
export function qrModules(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  const ecl = ECL_M;

  // バージョン選択（データが収まる最小版）
  let version = -1;
  let dataCapacityBits = 0;
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    const capacityBits = getNumDataCodewords(v, ecl.ordinal) * 8;
    const ccBits = v <= 9 ? 8 : 16; // バイトモードの文字数指標ビット長
    const usedBits = 4 + ccBits + data.length * 8;
    if (usedBits <= capacityBits) {
      version = v;
      dataCapacityBits = capacityBits;
      break;
    }
  }
  if (version === -1) throw new Error('データが大きすぎてQRに収まりません');

  // ビット列の組み立て
  const bb: number[] = [];
  appendBits(0x4, 4, bb); // バイトモード指示子
  appendBits(data.length, version <= 9 ? 8 : 16, bb);
  for (const b of data) appendBits(b, 8, bb);
  // 終端＋パディング
  appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
  appendBits(0, (8 - (bb.length % 8)) % 8, bb);
  for (let pad = 0xec; bb.length < dataCapacityBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bb);

  // バイト列へ
  const dataCodewords: number[] = new Array(bb.length >>> 3).fill(0);
  bb.forEach((bit, i) => (dataCodewords[i >>> 3] |= bit << (7 - (i & 7))));

  const allCodewords = addEccAndInterleave(dataCodewords, version, ecl.ordinal);
  return buildMatrix(version, ecl, allCodewords);
}

function addEccAndInterleave(data: number[], version: number, eclOrdinal: number): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[eclOrdinal][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[eclOrdinal][version];
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const rsDiv = reedSolomonComputeDivisor(blockEccLen);
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecc = reedSolomonComputeRemainder(dat.slice(), rsDiv);
    if (i < numShortBlocks) dat.push(0); // 短いブロックは後で揃えるためのプレースホルダ
    blocks.push(dat.concat(ecc));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      // 短ブロックのデータ部の最後（インデックス shortBlockLen-blockEccLen）はスキップ
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// --- 行列構築（機能パターン＋データ＋マスク） ---
function buildMatrix(version: number, ecl: typeof ECL_M, codewords: number[]): boolean[][] {
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunc = (x: number, y: number, val: boolean) => {
    modules[y][x] = val;
    isFunction[y][x] = true;
  };

  // タイミングパターン
  for (let i = 0; i < size; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }
  // ファインダー＋セパレータ
  const drawFinder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFunc(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // 位置合わせパターン
  const alignPos = getAlignmentPatternPositions(version);
  const numAlign = alignPos.length;
  for (let i = 0; i < numAlign; i++) {
    for (let j = 0; j < numAlign; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0)) continue;
      drawAlignment(alignPos[i], alignPos[j], setFunc);
    }
  }

  // フォーマット情報の予約と描画（マスク確定後に再描画するため一旦0で）
  drawFormatBits(0, ecl, size, setFunc);
  drawVersion(version, size, setFunc);

  // データ配置（ジグザグ）
  drawCodewords(codewords, modules, isFunction, size);

  // マスク選択（ペナルティ最小）
  let bestMask = 0;
  let minPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask, modules, isFunction, size);
    drawFormatBits(mask, ecl, size, setFunc);
    const penalty = getPenaltyScore(modules, size);
    if (penalty < minPenalty) {
      bestMask = mask;
      minPenalty = penalty;
    }
    applyMask(mask, modules, isFunction, size); // 元に戻す（XORなので同じマスクで戻る）
  }
  applyMask(bestMask, modules, isFunction, size);
  drawFormatBits(bestMask, ecl, size, setFunc);

  return modules;
}

function getAlignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function drawAlignment(cx: number, cy: number, setFunc: (x: number, y: number, v: boolean) => void): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunc(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFormatBits(mask: number, ecl: typeof ECL_M, size: number, setFunc: (x: number, y: number, v: boolean) => void): void {
  const dataVal = (ecl.formatBits << 3) | mask;
  let rem = dataVal;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((dataVal << 10) | rem) ^ 0x5412;

  const get = (i: number) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) setFunc(8, i, get(i));
  setFunc(8, 7, get(6));
  setFunc(8, 8, get(7));
  setFunc(7, 8, get(8));
  for (let i = 9; i < 15; i++) setFunc(14 - i, 8, get(i));
  for (let i = 0; i < 8; i++) setFunc(size - 1 - i, 8, get(i));
  for (let i = 8; i < 15; i++) setFunc(8, size - 15 + i, get(i));
  setFunc(8, size - 8, true); // 常に暗のモジュール
}

function drawVersion(version: number, size: number, setFunc: (x: number, y: number, v: boolean) => void): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunc(a, b, bit);
    setFunc(b, a, bit);
  }
}

function drawCodewords(codewords: number[], modules: boolean[][], isFunction: boolean[][], size: number): void {
  let i = 0; // ビットインデックス
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // タイミング列を避ける
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < codewords.length * 8) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

function applyMask(mask: number, modules: boolean[][], isFunction: boolean[][], size: number): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y][x]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) modules[y][x] = !modules[y][x];
    }
  }
}

function getPenaltyScore(modules: boolean[][], size: number): number {
  let result = 0;
  // 行・列の連続
  for (let y = 0; y < size; y++) {
    let runColor = false;
    let runX = 0;
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === runColor) {
        runX++;
        if (runX === 5) result += 3;
        else if (runX > 5) result++;
      } else {
        runColor = modules[y][x];
        runX = 1;
      }
    }
  }
  for (let x = 0; x < size; x++) {
    let runColor = false;
    let runY = 0;
    for (let y = 0; y < size; y++) {
      if (modules[y][x] === runColor) {
        runY++;
        if (runY === 5) result += 3;
        else if (runY > 5) result++;
      } else {
        runColor = modules[y][x];
        runY = 1;
      }
    }
  }
  // 2x2 同色ブロック
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
    }
  }
  // 暗モジュール比率
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * 10;
  return result;
}

/** otpauth URI 等の文字列を QR の SVG 文字列に変換する。border はモジュール数の余白。 */
export function qrSvg(text: string, opts: { size?: number; border?: number } = {}): string {
  const modules = qrModules(text);
  const n = modules.length;
  const border = opts.border ?? 4;
  const dim = n + border * 2;
  const parts: string[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules[y][x]) parts.push(`M${x + border},${y + border}h1v1h-1z`);
    }
  }
  const px = opts.size ?? 240;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${px}" height="${px}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QRコード">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${parts.join('')}" fill="#000000"/></svg>`
  );
}
