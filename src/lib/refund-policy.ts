/**
 * 返金の実行方法を、支払い方法から判定する（純関数・テスト可能）。
 *
 * 方針（オーナー確定・2026-08）:
 *  - カード（Stripe）／PayPal … システムが自動返金（管理者が金額を確認・調整して承認）
 *  - Stripe銀行振込／コンビニ払い … 自動返金しない。お客様に返金先口座を伺い、
 *    手動で銀行振込返金する（管理者対応）。
 *  - 請求書払い（invoice） … 同上、手動。
 *
 * ※ payment_method='stripe' は「カード or コンビニ」の両方を含むため、
 *   コンビニ（konbini）だけは stripeMethodType で判別して manual に落とす。
 */
export type RefundMode = 'auto_stripe' | 'auto_paypal' | 'manual';

export function refundModeFor(paymentMethod: string | null | undefined, stripeMethodType?: string | null): RefundMode {
  if (paymentMethod === 'paypal') return 'auto_paypal';
  if (paymentMethod === 'stripe') {
    if (stripeMethodType === 'konbini') return 'manual'; // コンビニは手動（顧客に口座を伺って振込返金）
    return 'auto_stripe'; // カード・Apple Pay 等
  }
  // bank_transfer（Stripe収納代行の振込）/ invoice（請求書払い）は手動
  return 'manual';
}

/** 手動返金かどうか（表示用ショートカット）。 */
export function isManualRefund(paymentMethod: string | null | undefined, stripeMethodType?: string | null): boolean {
  return refundModeFor(paymentMethod, stripeMethodType) === 'manual';
}

/**
 * 返金可能な上限（円）。支払い済み額から返金済み累計を引いた残り。
 * paid でない（未入金・請求書未払い等）は 0。
 */
export function maxRefundable(paymentStatus: string, paidAmount: number, refundedAmount: number): number {
  if (paymentStatus !== 'paid') return 0;
  return Math.max(0, Math.round(paidAmount) - Math.round(refundedAmount));
}

/** 入力返金額の妥当性チェック（1円以上・上限以下の整数）。 */
export function validateRefundAmount(amount: number, max: number): { ok: boolean; error?: string } {
  if (!Number.isFinite(amount)) return { ok: false, error: '金額が不正です' };
  const a = Math.round(amount);
  if (a <= 0) return { ok: false, error: '返金額は1円以上を指定してください' };
  if (a > max) return { ok: false, error: `返金可能額（¥${max.toLocaleString()}）を超えています` };
  return { ok: true };
}
