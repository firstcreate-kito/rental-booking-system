/**
 * 🔒 ポリシー固定テスト（キャンセル/変更ポリシーのガード）
 *
 * 目的：確定した統一ポリシー（docs/unified-change-cancel-policy.md・2026-09-06 オーナー合意）を
 *   値で固定する。ここが失敗する変更＝ポリシーに矛盾が生じる改修の可能性が高い。
 *   その場合は「勝手に直さず」オーナーへ確認する（CLAUDE.md のガードレール参照）。
 *
 * ※料率そのもの（cancel_policies）はDB設定だが、料率を"適用する計算"(computeCancelCharge)と
 *   チケット規則(ticket-policy)を固定することで、ロジック側の破壊を検知する。
 */
import { describe, it, expect } from 'vitest';
import { computeCancelCharge, type CancelPolicyTier } from '../src/lib/cancellation';
import { ticketCancelAction, ticketChangePlan } from '../src/lib/ticket-policy';
import { applyRefundFee, REFUND_FEE_PCT, REFUND_FEE_TAX_PCT, REFUND_TRANSFER_FEE } from '../src/lib/refund-fee';

// 当初利用日を固定し、現在日時を動かして料率を確認するヘルパ
const USE = '2026-10-01';
const at = (d: string) => `${d} 10:00:00`;
const pct = (tiers: CancelPolicyTier[], nowYmd: string) =>
  computeCancelCharge(tiers, USE, at(nowYmd), 10000).chargePct;

describe('🔒 現金キャンセル料率（防音室A・B／東別院）＝ 8日以上前0% / 2〜7日前50% / 前日・当日100%', () => {
  const piano: CancelPolicyTier[] = [
    { daysBefore: 7, chargePct: 50, cutoffTime: null },
    { daysBefore: 1, chargePct: 100, cutoffTime: null },
  ];
  it('8日以上前は無料', () => {
    expect(pct(piano, '2026-09-22')).toBe(0); // 9日前
    expect(pct(piano, '2026-09-23')).toBe(0); // 8日前
  });
  it('2〜7日前は50%', () => {
    expect(pct(piano, '2026-09-24')).toBe(50); // 7日前
    expect(pct(piano, '2026-09-29')).toBe(50); // 2日前
  });
  it('前日・当日は100%', () => {
    expect(pct(piano, '2026-09-30')).toBe(100); // 前日
    expect(pct(piano, '2026-10-01')).toBe(100); // 当日
  });
});

describe('🔒 現金キャンセル料率（標準スペース）＝ 31日前0% / 30〜15日50% / 14日〜前日80% / 当日100%', () => {
  const std: CancelPolicyTier[] = [
    { daysBefore: 30, chargePct: 50, cutoffTime: null },
    { daysBefore: 14, chargePct: 80, cutoffTime: null },
    { daysBefore: 0, chargePct: 100, cutoffTime: null },
  ];
  it('31日以上前は無料', () => {
    expect(pct(std, '2026-08-31')).toBe(0); // 31日前
  });
  it('30〜15日前は50%', () => {
    expect(pct(std, '2026-09-01')).toBe(50); // 30日前
    expect(pct(std, '2026-09-16')).toBe(50); // 15日前
  });
  it('14日前〜前日は80%', () => {
    expect(pct(std, '2026-09-17')).toBe(80); // 14日前
    expect(pct(std, '2026-09-30')).toBe(80); // 前日
  });
  it('当日は100%', () => {
    expect(pct(std, '2026-10-01')).toBe(100);
  });
});

describe('🔒 チケット キャンセル＝ 前々日まで返還 / 当日・前日失効', () => {
  it('前々日以前は返還', () => {
    expect(ticketCancelAction(2)).toBe('restore'); // 前々日
    expect(ticketCancelAction(7)).toBe('restore');
  });
  it('前日・当日は失効', () => {
    expect(ticketCancelAction(1)).toBe('forfeit'); // 前日
    expect(ticketCancelAction(0)).toBe('forfeit'); // 当日
  });
});

describe('🔒 返金手数料＝ カード/PayPal 3.7%＋税10%（率）／振込・コンビニ・請求書 一律¥350＋税10%（定額）', () => {
  it('率・定額・消費税の定数を固定', () => {
    expect(REFUND_FEE_PCT).toBe(3.7);
    expect(REFUND_FEE_TAX_PCT).toBe(10);
    expect(REFUND_TRANSFER_FEE).toBe(350);
  });
  it('カード（stripe）・PayPal は 3.7%＋消費税10%（切り上げ）を差し引く', () => {
    // 1650 × 3.7% × 1.10 = 67.155 → 切り上げ 68 → net 1582
    expect(applyRefundFee(1650, 'stripe')).toEqual({ gross: 1650, fee: 68, net: 1582, applied: true, kind: 'card', pct: 3.7, taxPct: 10, flatBase: 350 });
    expect(applyRefundFee(1650, 'paypal')).toEqual({ gross: 1650, fee: 68, net: 1582, applied: true, kind: 'card', pct: 3.7, taxPct: 10, flatBase: 350 });
    // 10000 × 3.7% × 1.10 = 407（丁度）→ net 9593
    expect(applyRefundFee(10000, 'stripe')).toEqual({ gross: 10000, fee: 407, net: 9593, applied: true, kind: 'card', pct: 3.7, taxPct: 10, flatBase: 350 });
  });
  it('銀行振込・コンビニ・請求書払いは 一律¥350＋消費税10%（＝¥385）を差し引く', () => {
    for (const m of ['bank_transfer', 'konbini', 'invoice']) {
      // 350 × 1.10 = 385（定額）→ 10000 − 385 = 9615
      expect(applyRefundFee(10000, m)).toEqual({ gross: 10000, fee: 385, net: 9615, applied: true, kind: 'transfer', pct: 3.7, taxPct: 10, flatBase: 350 });
    }
  });
  it('手数料が返金額を上回る場合は 返金額を上限に控除し ご返金額0円（マイナス返金にしない）', () => {
    // 振込：返金¥200 < 手数料¥385 → 手数料は¥200まで、net 0
    expect(applyRefundFee(200, 'bank_transfer')).toEqual({ gross: 200, fee: 200, net: 0, applied: true, kind: 'transfer', pct: 3.7, taxPct: 10, flatBase: 350 });
    expect(applyRefundFee(1, 'konbini').net).toBe(0);
  });
  it('対象外の決済方法・返金0円以下は控除なし（applied=false）', () => {
    expect(applyRefundFee(10000, 'unknown').applied).toBe(false);
    expect(applyRefundFee(10000, null).applied).toBe(false);
    expect(applyRefundFee(0, 'stripe')).toEqual({ gross: 0, fee: 0, net: 0, applied: false, kind: null, pct: 3.7, taxPct: 10, flatBase: 350 });
    expect(applyRefundFee(0, 'bank_transfer').applied).toBe(false);
  });
});

describe('🔒 チケット 変更＝ 前々日以前は全額返還 / 当日・前日は増減なし無償・減少失効・増加は不可', () => {
  it('前々日以前：全額返還（新予約で再消費）', () => {
    expect(ticketChangePlan(2, 2, 3)).toEqual({ action: 'restore_full', restoreHours: 2, forfeitHours: 0 });
  });
  it('当日・前日：増減なしは付け替え（返還なし）', () => {
    expect(ticketChangePlan(1, 2, 2)).toEqual({ action: 'move', restoreHours: 0, forfeitHours: 0 });
    expect(ticketChangePlan(0, 3, 3)).toEqual({ action: 'move', restoreHours: 0, forfeitHours: 0 });
  });
  it('当日・前日：減少は減少分を失効', () => {
    expect(ticketChangePlan(1, 3, 1)).toEqual({ action: 'partial_forfeit', restoreHours: 0, forfeitHours: 2 });
  });
  it('当日・前日：増加はチケット不可（新規予約で対応）', () => {
    const p = ticketChangePlan(0, 2, 3);
    expect(p.action).toBe('blocked');
    expect(p.restoreHours).toBe(0);
    expect(p.forfeitHours).toBe(0);
  });
});
