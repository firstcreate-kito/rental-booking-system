/**
 * ポイント関連の純粋計算（#70）。
 * 1ポイント=1円で利用でき、獲得は「利用金額 × 還元率(%)」の切り捨て。
 * 還元率は system_settings の point_rate（既定1）で管理し、管理画面から調整できる。
 */
import { addDays, daysBetween } from './calendar';

/** 利用金額（円）と還元率(%)から獲得ポイントを計算（端数切り捨て・非負） */
export function pointsForAmount(amountJpy: number, ratePercent: number): number {
  if (!(amountJpy > 0) || !(ratePercent > 0)) return 0;
  return Math.floor((amountJpy * ratePercent) / 100);
}

/** ポイント有効期限の既定（#78）：最終活動から1年 */
export const POINT_EXPIRY_DAYS = 365;
/** 期限接近メールを出す日数（#78）：30日前から */
export const POINT_EXPIRY_NOTICE_DAYS = 30;

export interface PointExpiryStatus {
  expiryDate: string; // 'YYYY-MM-DD'（最終活動日 + expiryDays）
  daysUntil: number; // 期限日 − 本日（負なら期限切れ）
  action: 'expire' | 'notice' | 'none';
}

/**
 * 最終活動日と本日から、失効/期限接近/対象外を判定する純粋関数（#78）。
 *   - daysUntil < 0        → expire（期限切れ・失効）
 *   - 0 <= daysUntil <= 通知日数 → notice（期限接近・お知らせ）
 *   - それ以外              → none
 * 有効期限は「最終活動（獲得または利用）から expiryDays 日」でローリング。
 */
export function pointExpiryStatus(
  lastActivityDate: string, // 'YYYY-MM-DD'
  today: string, // 'YYYY-MM-DD'
  opts?: { expiryDays?: number; noticeDays?: number },
): PointExpiryStatus {
  const expiryDays = opts?.expiryDays ?? POINT_EXPIRY_DAYS;
  const noticeDays = opts?.noticeDays ?? POINT_EXPIRY_NOTICE_DAYS;
  const expiryDate = addDays(lastActivityDate, expiryDays);
  const daysUntil = daysBetween(today, expiryDate);
  const action: PointExpiryStatus['action'] =
    daysUntil < 0 ? 'expire' : daysUntil <= noticeDays ? 'notice' : 'none';
  return { expiryDate, daysUntil, action };
}
