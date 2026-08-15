/**
 * ポイント関連の純粋計算（#70）。
 * 1ポイント=1円で利用でき、獲得は「利用金額 × 還元率(%)」の切り捨て。
 * 還元率は system_settings の point_rate（既定1）で管理し、管理画面から調整できる。
 */

/** 利用金額（円）と還元率(%)から獲得ポイントを計算（端数切り捨て・非負） */
export function pointsForAmount(amountJpy: number, ratePercent: number): number {
  if (!(amountJpy > 0) || !(ratePercent > 0)) return 0;
  return Math.floor((amountJpy * ratePercent) / 100);
}
