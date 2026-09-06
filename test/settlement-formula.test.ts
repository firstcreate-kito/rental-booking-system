import { describe, it, expect } from 'vitest';
import { cancelFormulaLines, rescheduleFormulaLines } from '../src/lib/settlement-formula';

describe('cancelFormulaLines（キャンセル計算式）', () => {
  it('現金・単一予約：対象金額×率＝キャンセル料、返金＝支払−料', () => {
    const lines = cancelFormulaLines({
      spaceName: '名駅フリースペース',
      daysBefore: 8,
      chargePctMax: 80,
      cancelFee: 27104,
      paidAmount: 33880,
      refundAmount: 6776,
      totalAmount: 33880,
      breakdown: [{ date: '2026-09-14', price: 33880, chargePct: 80, cancelFee: 27104 }],
    });
    const text = lines.join('\n');
    expect(text).toContain('¥33,880 × 80% = ¥27,104');
    expect(text).toContain('お支払い ¥33,880 − キャンセル料 ¥27,104 = ¥6,776');
  });

  it('未入金：返金なし（¥0）と明記', () => {
    const lines = cancelFormulaLines({
      spaceName: '名駅フリースペース', daysBefore: 40, chargePctMax: 0, cancelFee: 0,
      paidAmount: 0, refundAmount: 0, totalAmount: 6000,
      breakdown: [{ date: '2026-10-20', price: 6000, chargePct: 0, cancelFee: 0 }],
    });
    expect(lines.join('\n')).toContain('お支払い前のため なし（¥0）');
  });

  it('チケット・前々日まで＝返還', () => {
    const lines = cancelFormulaLines({
      spaceName: '名駅防音室A', daysBefore: 3, chargePctMax: 0, cancelFee: 0,
      paidAmount: 0, refundAmount: 0, totalAmount: 0, breakdown: [],
      ticket: { isTicket: true, action: 'restore', hours: 2 },
    });
    expect(lines.join('\n')).toContain('2時間を返還');
  });
});

describe('rescheduleFormulaLines（日時変更計算式）', () => {
  it('減額（80%）：短縮分×(100−率)＝返金', () => {
    const lines = rescheduleFormulaLines({
      spaceName: '名駅フリースペース', kind: 'decrease',
      currentTotal: 33880, newTotal: 24200, cancelChargePct: 80, refund: 1936, charge: 0,
    });
    const text = lines.join('\n');
    expect(text).toContain('短縮分：¥33,880 − ¥24,200 = ¥9,680');
    expect(text).toContain('¥9,680 × (100 − 80)% = ¥1,936');
  });

  it('増額：差額＝追加請求', () => {
    const lines = rescheduleFormulaLines({
      spaceName: '名駅フリースペース', kind: 'increase',
      currentTotal: 24200, newTotal: 33880, cancelChargePct: 0, refund: 0, charge: 9680,
    });
    expect(lines.join('\n')).toContain('¥33,880 − ¥24,200 = ¥9,680');
  });

  it('キャンセル扱い：旧返金なし・新満額', () => {
    const lines = rescheduleFormulaLines({
      spaceName: '名駅防音室A', kind: 'cancel_treatment',
      currentTotal: 6000, newTotal: 6000, cancelChargePct: 100, refund: 0, charge: 6000,
    });
    const text = lines.join('\n');
    expect(text).toContain('元のご予約は返金なし');
    expect(text).toContain('満額 ¥6,000');
  });

  it('チケット：現金精算なし', () => {
    const lines = rescheduleFormulaLines({
      spaceName: '名駅防音室A', kind: 'move',
      currentTotal: 0, newTotal: 0, cancelChargePct: 0, refund: 0, charge: 0, ticket: true,
    });
    expect(lines.join('\n')).toContain('現金の精算：なし（¥0）');
  });
});
