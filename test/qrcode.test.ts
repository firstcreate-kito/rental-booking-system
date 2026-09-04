import { describe, it, expect } from 'vitest';
import { qrModules, qrSvg } from '../src/lib/qrcode';

describe('qrModules（QRコード生成・構造の健全性）', () => {
  const m = qrModules('otpauth://totp/ALBE:admin@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ALBE&algorithm=SHA1&digits=6&period=30');

  it('正方形で size = 4*version+17（バージョン1以上）', () => {
    expect(m.length).toBeGreaterThan(0);
    expect(m.every((row) => row.length === m.length)).toBe(true);
    expect((m.length - 17) % 4).toBe(0);
  });

  it('左上ファインダーパターン（7x7）が正しい', () => {
    // 中心(3,3)から dist!=2 が暗。外周リング暗・その内側リング明・中央3x3暗。
    for (let y = 0; y <= 6; y++) {
      for (let x = 0; x <= 6; x++) {
        const dist = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        expect(m[y][x]).toBe(dist !== 2);
      }
    }
  });

  it('右上・左下にもファインダーがある（角の中央が暗）', () => {
    const n = m.length;
    expect(m[3][n - 4]).toBe(true); // 右上ファインダー中心
    expect(m[n - 4][3]).toBe(true); // 左下ファインダー中心
  });

  it('タイミングパターン（6行/6列）が交互', () => {
    const n = m.length;
    for (let i = 8; i < n - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
  });

  it('決定的（同じ入力で同じ出力）', () => {
    const a = qrModules('hello');
    const b = qrModules('hello');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('qrSvg', () => {
  it('SVG文字列を返す（rect/path を含む）', () => {
    const svg = qrSvg('otpauth://totp/ALBE:x?secret=ABCDEFGH');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<path');
    expect(svg).toContain('viewBox');
  });
});
