/**
 * 予約 ↔ Google カレンダー同期の高レベルヘルパー（Web予約・管理画面 共通）。
 * 予約台帳の正は Google カレンダー（#25/#27）。
 */
import type { Env } from '../types';
import type { MissingCalendarBookingRow } from '../db/repository';
import { gcalConfigured, freeBusy, insertEvent, deleteEvent, patchEventSummary, listEvents, conflictsWithBusy, rangesOverlap, toJstRfc3339 } from './gcal';

const TENTATIVE_PREFIX = '【商談中】';

/** 運用ルールの明記：変更はカレンダー直接編集ではなく管理画面から（GCal→システムの逆同期はしない） */
const CHANGE_NOTE =
  '※変更・キャンセルは予約管理システムから行ってください（このカレンダーを直接編集しても予約システムには反映されません）。';

function bookingSummary(eventName: string, customerName: string, tentative: boolean): string {
  return `${tentative ? TENTATIVE_PREFIX : ''}${eventName}（${customerName}）`;
}

/** カレンダー予定の説明文（予約番号・お客様・運用ルールの注意書き入り） */
function bookingDescription(bookingNumber: string, customerName: string, tentative: boolean): string {
  const label = tentative ? '（商談中）' : '';
  return `予約番号: ${bookingNumber}${label}\nお客様: ${customerName}\n（レンタルスペースALBE 予約システム）\n${CHANGE_NOTE}`;
}

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
 * 変更（reschedule）用の衝突チェック。自分自身のイベント（excludeEventIds）は
 * 除外して、外部予約とだけ重ならないか確認する（変更先が旧枠と重なっても誤検知しない）。
 */
export async function checkCalendarConflictExcluding(
  env: Env,
  calendarId: string | null,
  items: readonly DayItem[],
  excludeEventIds: readonly (string | null)[],
): Promise<{ conflict?: string; error?: string }> {
  if (!gcalConfigured(env) || !calendarId) return {};
  const exclude = new Set(excludeEventIds.filter((x): x is string => !!x));
  try {
    for (const it of items) {
      const startISO = toJstRfc3339(it.date, it.startTime);
      const endISO = toJstRfc3339(it.date, it.endTime);
      const events = await listEvents(env, calendarId, startISO, endISO);
      for (const ev of events) {
        if (exclude.has(ev.id)) continue;
        if (rangesOverlap(startISO, endISO, ev.start, ev.end)) {
          return { conflict: `${it.date} ${it.startTime}-${it.endTime}` };
        }
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
    tentative?: boolean; // 商談中は【商談中】マーカー付き
  },
): Promise<{ warning?: string }> {
  if (!gcalConfigured(env) || !calendarId) return {};
  try {
    const updates: D1PreparedStatement[] = [];
    for (let i = 0; i < args.items.length; i++) {
      const it = args.items[i];
      const ev = await insertEvent(env, calendarId, {
        summary: bookingSummary(args.eventName, args.customerName, !!args.tentative),
        description: bookingDescription(args.bookingNumber, args.customerName, !!args.tentative),
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

/**
 * 商談中 → 本予約化。既存イベントがあればタイトルの【商談中】マーカーを外し、
 * まだイベントが無い行（連携後追加等）には新規作成する。
 */
export async function promoteBookingCalendar(
  env: Env,
  calendarId: string | null,
  args: {
    bookingNumber: string;
    eventName: string;
    customerName: string;
    rows: ReadonlyArray<{ id: string; date: string; start_time: string; end_time: string; google_event_id: string | null }>;
  },
): Promise<{ warning?: string }> {
  if (!gcalConfigured(env) || !calendarId) return {};
  const summary = bookingSummary(args.eventName, args.customerName, false);
  try {
    const updates: D1PreparedStatement[] = [];
    for (const r of args.rows) {
      if (r.google_event_id) {
        await patchEventSummary(env, calendarId, r.google_event_id, summary);
      } else {
        const ev = await insertEvent(env, calendarId, {
          summary,
          description: bookingDescription(args.bookingNumber, args.customerName, false),
          startISO: toJstRfc3339(r.date, r.start_time),
          endISO: toJstRfc3339(r.date, r.end_time),
        });
        updates.push(env.DB.prepare('UPDATE bookings SET google_event_id = ? WHERE id = ?').bind(ev.id, r.id));
      }
    }
    if (updates.length) await env.DB.batch(updates);
    return {};
  } catch (err) {
    return { warning: `Googleカレンダーの本予約化に失敗しました: ${(err as Error).message}` };
  }
}

/**
 * 取りこぼし補完（#25/#27）: 書き込みに失敗して google_event_id が未設定のままの予約を
 * Google カレンダーへ再作成する。Cron から定期実行する。
 * 予約の変更はすべて管理画面（＝システム）経由という運用ルール前提のため、
 * 方向はシステム→GCal のみ（GCal→システムの取り込みは行わない）。
 */
export async function reconcileMissingCalendarEvents(
  env: Env,
  rows: readonly MissingCalendarBookingRow[],
): Promise<{ created: number; failed: number }> {
  if (!gcalConfigured(env) || rows.length === 0) return { created: 0, failed: 0 };
  let created = 0;
  let failed = 0;
  const updates: D1PreparedStatement[] = [];
  for (const r of rows) {
    if (!r.google_calendar_id) continue;
    const tentative = r.status === 'tentative';
    const name = r.contact_name ?? '';
    try {
      const ev = await insertEvent(env, r.google_calendar_id, {
        summary: bookingSummary(r.event_name, name, tentative),
        description: bookingDescription(r.booking_number, name, tentative),
        startISO: toJstRfc3339(r.date, r.start_time),
        endISO: toJstRfc3339(r.date, r.end_time),
      });
      updates.push(env.DB.prepare('UPDATE bookings SET google_event_id = ? WHERE id = ?').bind(ev.id, r.id));
      created++;
    } catch {
      failed++; // 次回のCronで再試行される
    }
  }
  if (updates.length) await env.DB.batch(updates);
  return { created, failed };
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
