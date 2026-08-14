/**
 * 予約 ↔ Google カレンダー同期の高レベルヘルパー（Web予約・管理画面 共通）。
 * 予約台帳の正は Google カレンダー（#25/#27）。
 */
import type { Env } from '../types';
import { gcalConfigured, freeBusy, insertEvent, deleteEvent, conflictsWithBusy, toJstRfc3339 } from './gcal';

export interface DayItem {
  date: string;
  startTime: string;
  endTime: string;
}

/**
 * その部屋のカレンダーを照会し、いずれかのコマが埋まっていれば conflict を返す。
 * 照会自体が失敗（認証/権限/ID等）しても予約を止めず error を返す（呼び出し側は
 * conflict のみで拒否判断する）。連携未設定・カレンダーID未設定なら空。
 */
export async function checkCalendarConflict(
  env: Env,
  calendarId: string | null,
  items: readonly DayItem[],
): Promise<{ conflict?: string; error?: string }> {
  if (!gcalConfigured(env) || !calendarId) return {};
  try {
    for (const it of items) {
      const startISO = toJstRfc3339(it.date, it.startTime);
      const endISO = toJstRfc3339(it.date, it.endTime);
      const busy = await freeBusy(env, calendarId, startISO, endISO);
      if (conflictsWithBusy(startISO, endISO, busy)) {
        return { conflict: `${it.date} ${it.startTime}-${it.endTime}` };
      }
    }
    return {};
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * 予約成立後、各コマを Google カレンダーへ書き込み、bookings.google_event_id に保存する。
 * 失敗しても予約は成立させ、警告文を返す。
 */
export async function writeBookingToCalendar(
  env: Env,
  calendarId: string | null,
  args: {
    bookingNumber: string;
    eventName: string;
    customerName: string;
    items: readonly DayItem[];
    bookingIds: readonly string[];
  },
): Promise<{ warning?: string }> {
  if (!gcalConfigured(env) || !calendarId) return {};
  try {
    const updates: D1PreparedStatement[] = [];
    for (let i = 0; i < args.items.length; i++) {
      const it = args.items[i];
      const ev = await insertEvent(env, calendarId, {
        summary: `${args.eventName}（${args.customerName}）`,
        description: `予約番号: ${args.bookingNumber}\nお客様: ${args.customerName}\n（レンタルスペースALBE 予約システム）`,
        startISO: toJstRfc3339(it.date, it.startTime),
        endISO: toJstRfc3339(it.date, it.endTime),
      });
      if (args.bookingIds[i]) {
        updates.push(env.DB.prepare('UPDATE bookings SET google_event_id = ? WHERE id = ?').bind(ev.id, args.bookingIds[i]));
      }
    }
    if (updates.length) await env.DB.batch(updates);
    return {};
  } catch (err) {
    return { warning: `Googleカレンダーへの書き込みに失敗しました（予約は成立しています）: ${(err as Error).message}` };
  }
}

/** 予約グループのイベントを Google カレンダーから削除（キャンセル時） */
export async function deleteBookingFromCalendar(
  env: Env,
  calendarId: string | null,
  eventIds: readonly (string | null)[],
): Promise<void> {
  if (!gcalConfigured(env) || !calendarId) return;
  for (const id of eventIds) {
    if (!id) continue;
    try {
      await deleteEvent(env, calendarId, id);
    } catch {
      // 削除失敗は握りつぶす（照合バッチで拾う想定）
    }
  }
}
