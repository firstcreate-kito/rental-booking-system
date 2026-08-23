import type { AppBindings } from '../types';
import { getExpiredStripeHolds, releaseUnpaidStripeHold, getBookingCalendarData } from '../db/repository';
import { deleteBookingFromCalendar } from './gcal-sync';
import { nowJST } from './clock';

type Env = AppBindings['Bindings'];

/**
 * 期限切れの後払い確保枠（confirmed・未入金）を解放する Cron 掃除（#39）。
 * コンビニ・銀行振込は confirmed（赤枠）で枠を確保するため、未入金のまま期限を過ぎたら解放する。
 * - コンビニ払い（払込票の有効期限は3日）… 作成から4日を過ぎた未入金を解放。
 *   Webhook（async_payment_failed / expired）が不達でも枠が永久に埋まらないための安全網。
 * - 銀行振込（着金に時間がかかり、checkout.session.expired が発火しない）… この掃除が
 *   主な解放手段。長めに10日の猶予を置いてから未入金を解放する。
 * 解放後に着金があったレアケースは settlePaidBookingSession が管理者へ通知する。
 */
export async function runReleaseExpiredKonbiniHolds(env: Env): Promise<{ released: number }> {
  const konbiniCutoff = nowJST(Date.now() - 4 * 24 * 60 * 60 * 1000); // 4日前より古い created_at
  const bankCutoff = nowJST(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10日前より古い created_at
  const holds = await getExpiredStripeHolds(env.DB, konbiniCutoff, bankCutoff);
  let released = 0;
  for (const h of holds) {
    const cal = await getBookingCalendarData(env.DB, h.id).catch(() => null);
    const ok = await releaseUnpaidStripeHold(env.DB, h.id);
    if (!ok) continue;
    released++;
    if (cal?.calendarId) {
      await deleteBookingFromCalendar(env, cal.calendarId, (cal.rows ?? []).map((r) => r.google_event_id)).catch(() => {});
    }
  }
  return { released };
}
