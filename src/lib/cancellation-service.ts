/**
 * キャンセル見積り（#100）: 会員マイページ・ゲスト変更ページ双方から使う共通処理。
 * ポリシー（cancellation.ts）に基づき、キャンセル料と返金額（確定額）を算出する。
 * ※手数料（カード3.6%・振込手数料）は考慮しない方針（#100・経営判断）。
 * ※実際の徴収・返金はスタッフが手動で行う（この関数は表示・通知用の金額を返すだけ）。
 */
import { getCancelPolicies } from '../db/repository';
import { selectCancelPolicy, computeCancelCharge, type CancelPolicyTier } from './cancellation';
import { daysBetween } from './calendar';

export interface CancelBreakdownRow {
  bookingId: string;
  date: string;
  price: number;
  daysBefore: number;
  chargePct: number;
  cancelFee: number;
}

/**
 * グループ全体のキャンセル料を段階ポリシーで計算する。
 * @param referenceDate 料率判定の基準日（省略時は各明細の利用日）。「当初利用日」を渡すと、
 *   遠い日へ日程変更してから無料キャンセルする抜け穴を防げる（#99）。
 */
export async function computeGroupCancel(
  db: D1Database,
  spaceId: string,
  bookings: Array<{ id: string; date: string; price: number; status: string }>,
  now: string,
  referenceDate?: string | null,
): Promise<{ totalFee: number; breakdown: CancelBreakdownRow[] }> {
  const policiesAll = await getCancelPolicies(db);
  const tiers: CancelPolicyTier[] = selectCancelPolicy(
    policiesAll.map((p) => ({ spaceId: p.space_id, daysBefore: p.days_before, chargePct: p.charge_pct, cutoffTime: p.cutoff_time })),
    spaceId,
  );
  const today = now.slice(0, 10);
  let totalFee = 0;
  const breakdown = bookings
    .filter((b) => b.status !== 'cancelled')
    .map((b) => {
      const ref = referenceDate || b.date; // 当初利用日があればそれを基準に料率を判定
      const charge = computeCancelCharge(tiers, ref, now, b.price);
      totalFee += charge.cancelFee;
      return { bookingId: b.id, date: b.date, price: b.price, daysBefore: daysBetween(today, ref), chargePct: charge.chargePct, cancelFee: charge.cancelFee };
    });
  return { totalFee, breakdown };
}

export interface CancelQuote {
  /** キャンセル料（確定額・税込） */
  cancelFee: number;
  /** ご返金額（確定額）＝ max(0, 支払済み − キャンセル料) */
  refundAmount: number;
  /** 入金済み金額（未入金は0） */
  paidAmount: number;
  /** 予約合計（税込） */
  totalAmount: number;
  /** 支払いステータス（paid/unpaid/invoice 等） */
  paymentStatus: string;
  /** 適用された最大のキャンセル料率（%） */
  chargePctMax: number;
  /** 利用日までの残日数（最も早い利用日基準・なければ null） */
  daysBefore: number | null;
  breakdown: CancelBreakdownRow[];
}

/**
 * お客様に提示するキャンセル見積り（確定額）を返す。
 * 返金額 ＝ max(0, 入金済み金額 − キャンセル料)。未入金予約は返金0。
 */
export async function quoteCancellation(
  db: D1Database,
  group: { space_id: string; total_amount: number; payment_status: string; original_date?: string | null },
  bookings: Array<{ id: string; date: string; price: number; status: string }>,
  now: string,
): Promise<CancelQuote> {
  // 当初利用日を基準に料率を判定（遠い日へ変更→無料キャンセルの抜け穴を防ぐ #99）
  const { totalFee, breakdown } = await computeGroupCancel(db, group.space_id, bookings, now, group.original_date ?? null);
  const paidAmount = group.payment_status === 'paid' ? group.total_amount : 0;
  const refundAmount = Math.max(0, paidAmount - totalFee);
  const chargePctMax = breakdown.reduce((m, b) => Math.max(m, b.chargePct), 0);
  const today = now.slice(0, 10);
  const earliest = breakdown.map((b) => b.date).sort()[0];
  const daysBefore = earliest ? daysBetween(today, earliest) : null;
  return {
    cancelFee: totalFee,
    refundAmount,
    paidAmount,
    totalAmount: group.total_amount,
    paymentStatus: group.payment_status,
    chargePctMax,
    daysBefore,
    breakdown,
  };
}
