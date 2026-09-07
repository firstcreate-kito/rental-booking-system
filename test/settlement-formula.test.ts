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

  it('カード決済：決済手数料（3.7%＋消費税10%）控除行と説明文を追記（算術は控除前で表示）', () => {
    const lines = cancelFormulaLines({
      spaceName: '東別院24hピアノスタジオ',
      daysBefore: 20, chargePctMax: 0, cancelFee: 0,
      paidAmount: 1650, refundAmount: 1650, totalAmount: 1650,
      breakdown: [{ date: '2026-09-22', price: 1650, chargePct: 0, cancelFee: 0 }],
      refundFee: { fee: 68, net: 1582, pct: 3.7, taxPct: 10 },
    });
    const text = lines.join('\n');
    expect(text).toContain('お支払い ¥1,650 − キャンセル料 ¥0 = ¥1,650'); // 算術は控除前(gross)
    expect(text).toContain('決済手数料（カード／PayPal決済 3.7%＋消費税10%）：− ¥68');
    expect(text).toContain('お客様へのご返金額：¥1,582');
    expect(text).toContain('決済手数料（3.7%＋消費税10%）を差し引いた金額を返金いたします');
  });

  it('未入金・手数料指定なし：手数料行は出ない', () => {
    const lines = cancelFormulaLines({
      spaceName: '名駅フリースペース', daysBefore: 40, chargePctMax: 0, cancelFee: 0,
      paidAmount: 0, refundAmount: 0, totalAmount: 6000,
      breakdown: [{ date: '2026-10-20', price: 6000, chargePct: 0, cancelFee: 0 }],
    });
    expect(lines.join('\n')).not.toContain('決済手数料');
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

  it('減額・カード決済：決済手数料（3.7%＋消費税10%）控除行と説明文を追記', () => {
    const lines = rescheduleFormulaLines({
      spaceName: '名駅フリースペース', kind: 'decrease',
      currentTotal: 33880, newTotal: 24200, cancelChargePct: 0, refund: 9680, charge: 0,
      refundFee: { fee: 394, net: 9286, pct: 3.7, taxPct: 10 }, // 9680×3.7%×1.10=393.976→切上394
    });
    const text = lines.join('\n');
    expect(text).toContain('短縮分を全額返金 ¥9,680'); // 算術は控除前(gross)
    expect(text).toContain('決済手数料（カード／PayPal決済 3.7%＋消費税10%）：− ¥394');
    expect(text).toContain('お客様へのご返金額：¥9,286');
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
