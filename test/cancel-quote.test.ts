import { describe, it, expect } from 'vitest';
import { quoteCancellation } from '../src/lib/cancellation-service';

// getCancelPolicies は db.prepare(sql).all() だけを使うので、それだけ満たす簡易モック。
function fakeDb(policies: unknown[]): any {
  return {
    prepare: () => ({
      all: async () => ({ results: policies }),
      bind: () => ({ all: async () => ({ results: policies }) }),
    }),
  };
}

// 共通ポリシー: 31日前まで0%／30〜15日前50%／14日前〜前日80%／当日100%
const POLICIES = [
  { space_id: null, days_before: 30, charge_pct: 50, cutoff_time: null },
  { space_id: null, days_before: 14, charge_pct: 80, cutoff_time: null },
  { space_id: null, days_before: 0, charge_pct: 100, cutoff_time: null },
];

describe('quoteCancellation（#100 キャンセル見積り・確定額）', () => {
  it('入金済み・14日前〜前日（80%）: キャンセル料80%・返金は残り', async () => {
    const q = await quoteCancellation(
      fakeDb(POLICIES),
      { space_id: 'S1', total_amount: 4840, payment_status: 'paid' },
      [{ id: 'b1', date: '2026-09-11', price: 4840, status: 'confirmed' }],
      '2026-09-01 10:00:00',
    );
    expect(q.cancelFee).toBe(3872); // 4840 * 80%
    expect(q.refundAmount).toBe(968); // 4840 - 3872
    expect(q.chargePctMax).toBe(80);
    expect(q.paidAmount).toBe(4840);
  });

  it('未入金: 返金は0（支払いがないため）', async () => {
    const q = await quoteCancellation(
      fakeDb(POLICIES),
      { space_id: 'S1', total_amount: 4840, payment_status: 'unpaid' },
      [{ id: 'b1', date: '2026-09-11', price: 4840, status: 'confirmed' }],
      '2026-09-01 10:00:00',
    );
    expect(q.cancelFee).toBe(3872);
    expect(q.paidAmount).toBe(0);
    expect(q.refundAmount).toBe(0);
  });

  it('31日以上前（0%）: キャンセル料なし・全額返金', async () => {
    const q = await quoteCancellation(
      fakeDb(POLICIES),
      { space_id: 'S1', total_amount: 4840, payment_status: 'paid' },
      [{ id: 'b1', date: '2026-10-20', price: 4840, status: 'confirmed' }],
      '2026-09-01 10:00:00',
    );
    expect(q.cancelFee).toBe(0);
    expect(q.chargePctMax).toBe(0);
    expect(q.refundAmount).toBe(4840);
  });

  it('キャンセル済みの明細は集計対象外', async () => {
    const q = await quoteCancellation(
      fakeDb(POLICIES),
      { space_id: 'S1', total_amount: 4840, payment_status: 'paid' },
      [
        { id: 'b1', date: '2026-09-11', price: 4840, status: 'cancelled' },
        { id: 'b2', date: '2026-09-11', price: 3000, status: 'confirmed' },
      ],
      '2026-09-01 10:00:00',
    );
    expect(q.cancelFee).toBe(2400); // 3000 * 80%（b1は除外）
  });
});
