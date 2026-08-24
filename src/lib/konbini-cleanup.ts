import type { AppBindings } from '../types';
import { getUnpaidHoldCandidates, releaseUnpaidStripeHold, getBookingCalendarData } from '../db/repository';
import { deleteBookingFromCalendar } from './gcal-sync';
import { nowJST, todayJST, addDaysJST } from './clock';

type Env = AppBindings['Bindings'];

/** 作成からの解放猶予（日数）。この日数を過ぎた未入金は解放する。 */
const KONBINI_RELEASE_DAYS = 4; // コンビニ（払込票の有効期限は約3日。1日の余裕をみて4日）
const TRANSFER_RELEASE_DAYS = 10; // 銀行振込・請求書払い（着金・入金確認に時間がかかるため長め）

/**
 * 期限切れの後払い確保枠（confirmed・未入金）を解放する Cron 掃除（#39）。
 * コンビニ・銀行振込・請求書払いは confirmed（赤枠）で枠を確保するため、未入金のまま
 * 期限を過ぎたら解放する。解放条件は支払い方法ごとに次の「早い方」で判定する：
 *   (A) 作成から所定日数を経過（コンビニ=4日 / 銀行振込・請求書=10日）
 *   (B) ご利用日の前日に到達（利用日 <= 明日）… 未入金のまま利用日を迎えて枠を塞がないため
 * - コンビニ払い … Webhook（async_payment_failed / expired）が不達でも枠が永久に埋まらない安全網。
 * - 銀行振込 … checkout.session.expired が発火しないため、この掃除が主な解放手段。
 * - 請求書払い（手動） … 入金確認は手動だが、期限内未入金は同じルールで自動解放する。
 * 解放後に着金があったレアケースは settlePaidBookingSession が管理者へ通知する。
 */
export async function runReleaseExpiredKonbiniHolds(env: Env): Promise<{ released: number }> {
  const now = Date.now();
  const konbiniCutoff = nowJST(now - KONBINI_RELEASE_DAYS * 24 * 60 * 60 * 1000); // これより古い created_at は解放
  const transferCutoff = nowJST(now - TRANSFER_RELEASE_DAYS * 24 * 60 * 60 * 1000);
  // 利用日の前日到達の判定に使う上限日（利用日 <= 明日 なら解放）
  const useCutoffDate = addDaysJST(todayJST(), 1);

  const candidates = await getUnpaidHoldCandidates(env.DB);
  let released = 0;
  for (const h of candidates) {
    const createdCutoff = h.payment_method === 'stripe' ? konbiniCutoff : transferCutoff;
    const createdExpired = h.created_at < createdCutoff;
    const useImminent = !!h.earliest_date && h.earliest_date <= useCutoffDate;
    if (!createdExpired && !useImminent) continue;

    const cal = await getBookingCalendarData(env.DB, h.id).catch(() => null);
    const ok = await releaseUnpaidStripeHold(env.DB, h.id);
    if (!ok) continue;
    released++;
    console.warn('[release] unpaid hold auto-cancelled', {
      groupId: h.id,
      method: h.payment_method,
      createdAt: h.created_at,
      earliestDate: h.earliest_date,
      reason: createdExpired ? 'created-expired' : 'use-date-imminent',
    });
    if (cal?.calendarId) {
      await deleteBookingFromCalendar(env, cal.calendarId, (cal.rows ?? []).map((r) => r.google_event_id)).catch(() => {});
    }
  }
  return { released };
}
