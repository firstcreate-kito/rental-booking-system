import { describe, it, expect } from 'vitest';
import {
  computeCancelCharge,
  selectCancelPolicy,
  canSelfCancel,
  computeAdjustment,
  type CancelPolicyTier,
} from '../src/lib/cancellation';

// 基本ポリシー（当日100% / 14日前〜前日80% / 30〜15日前50% / 31日以前0%）
const basic: CancelPolicyTier[] = [
  { daysBefore: 30, chargePct: 50 },
  { daysBefore: 14, chargePct: 80 },
  { daysBefore: 0, chargePct: 100 },
];

// 特別ポリシー（前日17:00以降100%）
const special: CancelPolicyTier[] = [
  { daysBefore: 30, chargePct: 50 },
  { daysBefore: 14, chargePct: 80 },
  { daysBefore: 1, chargePct: 100, cutoffTime: '17:00' },
];

const USAGE = '2026-09-20';

describe('computeCancelCharge - 基本ポリシー', () => {
  it('31日以前 → 0%（全額返金）', () => {
    expect(computeCancelCharge(basic, USAGE, '2026-08-15 10:00:00', 10000).chargePct).toBe(0);
  });
  it('30日前 → 50%', () => {
    expect(computeCancelCharge(basic, USAGE, '2026-08-21 10:00:00', 10000).chargePct).toBe(50);
  });
  it('15日前 → 50%', () => {
    expect(computeCancelCharge(basic, USAGE, '2026-09-05 10:00:00', 10000).chargePct).toBe(50);
  });
  it('14日前 → 80%', () => {
    const r = computeCancelCharge(basic, USAGE, '2026-09-06 10:00:00', 10000);
    expect(r.chargePct).toBe(80);
    expect(r.cancelFee).toBe(8000);
  });
  it('前日 → 80%', () => {
    expect(computeCancelCharge(basic, USAGE, '2026-09-19 23:00:00', 10000).chargePct).toBe(80);
  });
  it('当日 → 100%', () => {
    const r = computeCancelCharge(basic, USAGE, '2026-09-20 09:00:00', 10000);
    expect(r.chargePct).toBe(100);
    expect(r.cancelFee).toBe(10000);
  });
});

describe('computeCancelCharge - 特別ポリシー(前日17:00境界)', () => {
  it('前日16:59 → まだ80%', () => {
    expect(computeCancelCharge(special, USAGE, '2026-09-19 16:59:00', 10000).chargePct).toBe(80);
  });
  it('前日17:00ちょうど → 100%', () => {
    expect(computeCancelCharge(special, USAGE, '2026-09-19 17:00:00', 10000).chargePct).toBe(100);
  });
  it('前日18:00 → 100%', () => {
    expect(computeCancelCharge(special, USAGE, '2026-09-19 18:00:00', 10000).chargePct).toBe(100);
  });
  it('15日前 → 基本と同じ50%', () => {
    expect(computeCancelCharge(special, USAGE, '2026-09-05 10:00:00', 10000).chargePct).toBe(50);
  });
});

describe('selectCancelPolicy', () => {
  it('スペース個別があれば優先、なければ共通', () => {
    const all = [
      { spaceId: null, daysBefore: 7, chargePct: 30 },
      { spaceId: null, daysBefore: 0, chargePct: 100 },
      { spaceId: 'hall', daysBefore: 3, chargePct: 50 },
    ];
    expect(selectCancelPolicy(all, 'hall')).toEqual([
      { daysBefore: 3, chargePct: 50, cutoffTime: null },
    ]);
    expect(selectCancelPolicy(all, 'other')).toEqual([
      { daysBefore: 7, chargePct: 30, cutoffTime: null },
      { daysBefore: 0, chargePct: 100, cutoffTime: null },
    ]);
  });
});

describe('canSelfCancel', () => {
  it('不可ステータス → 不可', () => {
    const r = canSelfCancel({ canSelfCancel: false, cancelDeadlineDays: null }, 0, 2, 10);
    expect(r.allowed).toBe(false);
  });

  it('締切超過 → 不可', () => {
    const r = canSelfCancel({ canSelfCancel: true, cancelDeadlineDays: 7 }, 0, 2, 5);
    expect(r.allowed).toBe(false);
  });

  it('月間上限到達 → 不可', () => {
    const r = canSelfCancel({ canSelfCancel: true, cancelDeadlineDays: 3 }, 2, 2, 10);
    expect(r.allowed).toBe(false);
  });

  it('条件クリア → 可能', () => {
    const r = canSelfCancel({ canSelfCancel: true, cancelDeadlineDays: 3 }, 1, 2, 10);
    expect(r.allowed).toBe(true);
  });
});

describe('computeAdjustment', () => {
  it('値上がり → surcharge', () => {
    expect(computeAdjustment(10000, 13000)).toEqual({ type: 'surcharge', amount: 3000 });
  });
  it('値下がり → refund', () => {
    expect(computeAdjustment(13000, 10000)).toEqual({ type: 'refund', amount: 3000 });
  });
  it('同額 → zero', () => {
    expect(computeAdjustment(10000, 10000)).toEqual({ type: 'zero', amount: 0 });
  });
});
