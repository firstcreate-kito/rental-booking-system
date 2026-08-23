import type { AppBindings } from '../types';
import { getExpiredKonbiniHolds, releaseUnpaidKonbiniHold, getBookingCalendarData } from '../db/repository';
import { deleteBookingFromCalendar } from './gcal-sync';
import { nowJST } from './clock';

type Env = AppBindings['Bindings'];

/**
 * 期限切れのコンビニ仮押さえ（tentative・stripe・未入金）を解放する Cron 掃除（#39）。
 * Webhook（async_payment_failed / expired）が不達でも枠が永久に埋まらないようにする安全網。
 * 払込票の有効期限は3日なので、作成から4日を過ぎても未入金のものを対象にする。
 */
export async function runReleaseExpiredKonbiniHolds(env: Env): Promise<{ released: number }> {
  const cutoff = nowJST(Date.now() - 4 * 24 * 60 * 60 * 1000); // 4日前より古い created_at
  const holds = await getExpiredKonbiniHolds(env.DB, cutoff);
  let released = 0;
  for (const h of holds) {
    const cal = await getBookingCalendarData(env.DB, h.id).catch(() => null);
    const ok = await releaseUnpaidKonbiniHold(env.DB, h.id);
    if (!ok) continue;
    released++;
    if (cal?.calendarId) {
      await deleteBookingFromCalendar(env, cal.calendarId, (cal.rows ?? []).map((r) => r.google_event_id)).catch(() => {});
    }
  }
  return { released };
}
