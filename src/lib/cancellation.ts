/**
 * キャンセル料計算 / セルフキャンセル可否 / 日時変更の差額計算
 *
 * cancel_policies（段階制・時刻境界対応）:
 *   各段階は「利用日の days_before 日前の cutoff_time 時刻から charge_pct% になる」を表す。
 *   （cutoff_time 省略時は '00:00'）
 *   適用中の段階のうち「開始時刻が最も遅い（＝最も厳しい）」ものを採用。
 *
 *   基本ポリシー例: [{30,50},{14,80},{0,100}]
 *     - 31日以前 → どの段階も未開始 → 0%（全額返金）
 *     - 30〜15日前 → 50%
 *     - 14日前〜前日 → 80%
 *     - 当日 → 100%
 *   特別ポリシー例（前日17:00以降100%）: [{30,50},{14,80},{1,100,'17:00'}]
 */
import { addDays } from './calendar';

export interface CancelPolicyTier {
  daysBefore: number; // 利用日の何日前(0=当日)
  chargePct: number; // キャンセル料率(%)
  cutoffTime?: string | null; // その日の適用開始時刻 'HH:MM'（省略時'00:00'）
}

export interface CancelChargeResult {
  chargePct: number;
  cancelFee: number;
  appliedTier: CancelPolicyTier | null;
}

/**
 * 適用するキャンセルポリシーを選ぶ。
 * スペース個別ポリシーがあればそれを優先、なければ共通ポリシー。
 */
export function selectCancelPolicy(
  tiers: ReadonlyArray<CancelPolicyTier & { spaceId: string | null }>,
  spaceId: string,
): CancelPolicyTier[] {
  const spaceSpecific = tiers.filter((t) => t.spaceId === spaceId);
  const source = spaceSpecific.length > 0 ? spaceSpecific : tiers.filter((t) => t.spaceId === null);
  return source.map((t) => ({
    daysBefore: t.daysBefore,
    chargePct: t.chargePct,
    cutoffTime: t.cutoffTime ?? null,
  }));
}

/** 段階の適用開始日時 'YYYY-MM-DD HH:MM:SS' */
function tierActivation(usageDate: string, tier: CancelPolicyTier): string {
  const date = addDays(usageDate, -tier.daysBefore);
  const time = tier.cutoffTime && /^\d{1,2}:\d{2}$/.test(tier.cutoffTime) ? tier.cutoffTime : '00:00';
  const [h, m] = time.split(':');
  return `${date} ${h.padStart(2, '0')}:${m}:00`;
}

/**
 * キャンセル料を計算する。
 * @param usageDate 利用日 'YYYY-MM-DD'
 * @param nowDateTime 現在日時(JST) 'YYYY-MM-DD HH:MM:SS'
 * @param originalPrice 対象金額（スペース料金）
 */
export function computeCancelCharge(
  tiers: readonly CancelPolicyTier[],
  usageDate: string,
  nowDateTime: string,
  originalPrice: number,
): CancelChargeResult {
  const active = tiers
    .map((t) => ({ tier: t, activation: tierActivation(usageDate, t) }))
    .filter((x) => nowDateTime >= x.activation);
  if (active.length === 0) {
    return { chargePct: 0, cancelFee: 0, appliedTier: null };
  }
  // 開始時刻が最も遅い＝最も厳しい段階を採用
  const applied = active.reduce((a, b) => (b.activation > a.activation ? b : a)).tier;
  const cancelFee = Math.round((originalPrice * applied.chargePct) / 100);
  return { chargePct: applied.chargePct, cancelFee, appliedTier: applied };
}

// ---------------------------------------------------------------------------
// セルフキャンセル可否（会員ステータス）
// ---------------------------------------------------------------------------

export interface SelfCancelStatusConfig {
  canSelfCancel: boolean;
  cancelDeadlineDays: number | null; // 利用日の何日前まで可能
}

export interface SelfCancelCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * セルフキャンセルが可能かを判定。
 * @param monthlyCount 今月すでにセルフキャンセルした回数
 * @param monthlyLimit 月間上限
 * @param actualDaysBefore 利用日までの残日数
 */
export function canSelfCancel(
  status: SelfCancelStatusConfig,
  monthlyCount: number,
  monthlyLimit: number,
  actualDaysBefore: number,
): SelfCancelCheckResult {
  if (!status.canSelfCancel) {
    return { allowed: false, reason: 'このステータスではセルフキャンセルできません' };
  }
  if (status.cancelDeadlineDays != null && actualDaysBefore < status.cancelDeadlineDays) {
    return {
      allowed: false,
      reason: `セルフキャンセルは利用日の${status.cancelDeadlineDays}日前までです`,
    };
  }
  if (monthlyCount >= monthlyLimit) {
    return { allowed: false, reason: `今月のセルフキャンセル上限（${monthlyLimit}回）に達しています` };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// 日時変更・オプション変更の差額
// ---------------------------------------------------------------------------

export type AdjustmentType = 'surcharge' | 'refund' | 'zero';

export interface AdjustmentResult {
  type: AdjustmentType;
  amount: number; // 絶対値
}

/** 旧合計 → 新合計 の差額を求める */
export function computeAdjustment(oldTotal: number, newTotal: number): AdjustmentResult {
  const diff = newTotal - oldTotal;
  if (diff > 0) return { type: 'surcharge', amount: diff };
  if (diff < 0) return { type: 'refund', amount: -diff };
  return { type: 'zero', amount: 0 };
}
