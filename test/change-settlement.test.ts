import { describe, it, expect } from 'vitest';
import { computeChangeSettlement } from '../src/lib/change-settlement';

describe('computeChangeSettlement（変更の精算額・統一ポリシー§2）', () => {
  it('無償の時期（キャンセル料0%）で同じ時間数の移動＝返金/請求なし', () => {
    const r = computeChangeSettlement(6000, 6000, 0);
    expect(r).toMatchObject({ kind: 'move', refund: 0, charge: 0 });
  });

  it('増額＝差額を追加請求', () => {
    const r = computeChangeSettlement(6000, 9000, 0);
    expect(r).toMatchObject({ kind: 'increase', refund: 0, charge: 3000 });
  });

  it('減額（キャンセル料0%の時期）＝短縮分を全額返金', () => {
    const r = computeChangeSettlement(9000, 6000, 0);
    expect(r).toMatchObject({ kind: 'decrease', refund: 3000, charge: 0 });
  });

  it('減額（キャンセル料50%の時期）＝短縮分の50%だけ返金', () => {
    const r = computeChangeSettlement(9000, 6000, 50); // 減少3000 → 50%=1500返金
    expect(r).toMatchObject({ kind: 'decrease', refund: 1500, charge: 0 });
  });

  it('キャンセル扱い（キャンセル料100%）＝旧予約は返金0・新予約は満額請求', () => {
    const r = computeChangeSettlement(6000, 6000, 100);
    expect(r).toMatchObject({ kind: 'cancel_treatment', refund: 0, charge: 6000 });
  });

  it('キャンセル扱い時は減額でも旧返金0・新満額（減った新予約額を請求）', () => {
    const r = computeChangeSettlement(9000, 6000, 100);
    expect(r).toMatchObject({ kind: 'cancel_treatment', refund: 0, charge: 6000 });
  });
});
