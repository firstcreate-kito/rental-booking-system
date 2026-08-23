/**
 * 予約 ↔ Google カレンダー同期の高レベルヘルパー（Web予約・管理画面 共通）。
 * 予約台帳の正は Google カレンダー（#25/#27）。
 */
import type { Env } from '../types';
import type { MissingCalendarBookingRow, BookingCalendarData } from '../db/repository';
import { getBookingCalendarData } from '../db/repository';
import { gcalConfigured, freeBusy, insertEvent, deleteEvent, patchEventSummary, patchEventContent, listEvents, conflictsWithBusy, rangesOverlap, toJstRfc3339 } from './gcal';
import { toMinutes } from './time';

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
  const origin = env.PUBLIC_BASE_URL || '';
  let created = 0;
  let failed = 0;
  const updates: D1PreparedStatement[] = [];
  // グループの詳細（タイトル・説明の生成に必要）はグループ単位でキャッシュして再取得を避ける
  const dataCache = new Map<string, BookingCalendarData | null>();
  for (const r of rows) {
    if (!r.google_calendar_id) continue;
    const tentative = r.status === 'tentative';
    const name = r.contact_name ?? '';
    try {
      let data = dataCache.get(r.group_id);
      if (data === undefined) {
        data = await getBookingCalendarData(env.DB, r.group_id);
        dataCache.set(r.group_id, data);
      }
      // 通常同期と同じリッチ形式で作成（取得失敗時のみ簡易形式でフォールバック）
      const summary = data ? buildCalendarTitle(data, tentative) : bookingSummary(r.event_name, name, tentative);
      const description = data ? buildCalendarDescription(data, origin) : bookingDescription(r.booking_number, name, tentative);
      const ev = await insertEvent(env, r.google_calendar_id, {
        summary,
        description,
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

// ---------------------------------------------------------------------------
// リッチなカレンダー出力（タイトル・説明の充実）
// ---------------------------------------------------------------------------

const yenFmt = (n: number): string => '¥' + Number(n || 0).toLocaleString('ja-JP');

/** 合計利用時間の表示（例: 9時間 / 1.5時間）。外部サイネージがこの表記を解釈する。 */
function totalHoursLabel(rows: ReadonlyArray<{ start_time: string; end_time: string }>): string {
  const mins = rows.reduce((s, r) => s + (toMinutes(r.end_time) - toMinutes(r.start_time)), 0);
  const h = mins / 60;
  return (Number.isInteger(h) ? String(h) : h.toFixed(1)) + '時間';
}

/** 支払い方法の表示（カード/コンビニは Stripe に集約されるため併記） */
function paymentMethodText(paymentMethod: string | null): string {
  const map: Record<string, string> = {
    stripe: 'クレジットカード／コンビニ払い',
    paypal: 'PayPal',
    bank_transfer: '銀行振込',
    invoice: '請求書払い',
  };
  return map[paymentMethod || ''] || '—';
}

/** 支払いステータスの表示（完了／入金待ち） */
function paymentStatusText(paymentStatus: string, total: number): string {
  if (total <= 0) return '支払不要（¥0）';
  if (paymentStatus === 'paid') return '完了';
  if (paymentStatus === 'invoice') return '請求書払い（未入金）';
  return '入金待ち';
}

/**
 * タイトル：「【予約完了】 お客様名｜ スペース名／N時間」（例：【予約完了】 山田 太郎｜ 名駅フリースペース／9時間）
 * 外部サイネージがこの表記（全角の｜・／、半角スペース）を解釈するため、書式は変更しないこと。
 */
export function buildCalendarTitle(data: BookingCalendarData, tentative: boolean): string {
  const badge = tentative ? '【商談中】' : '【予約完了】';
  const sp = data.spaceName ? `｜ ${data.spaceName}` : '';
  return `${badge} ${data.customerName}${sp}／${totalHoursLabel(data.rows)}`;
}

/** 説明欄：予約の基本情報を出力 */
export function buildCalendarDescription(data: BookingCalendarData, origin: string): string {
  const optLabel = data.options.length ? data.options.map((o) => `${o.name}×${o.quantity}`).join('／') : 'なし';
  const adminUrl = origin ? `${origin}/admin.html?booking=${encodeURIComponent(data.bookingNumber)}` : '';
  const lines = [
    `予約番号：${data.bookingNumber}`,
    `イベント名：${data.eventName || '—'}`,
    `利用目的：${data.purpose || '—'}`,
    `ご利用人数：${data.headcount != null ? data.headcount + '名' : '—'}`,
    `過去のご利用実績：${data.repeatCustomer ? '利用経験あり' : '初回利用'}`,
    `オプション：${optLabel}`,
    `メールアドレス：${data.email || '—'}`,
    `電話番号：${data.phone || '—'}`,
    `会社名：${data.company || '—'}`,
    `支払い方法：${paymentMethodText(data.paymentMethod)}`,
    `支払いステータス：${paymentStatusText(data.paymentStatus, data.total)}`,
    `ご利用金額（税込）：${yenFmt(data.total)}`,
    adminUrl ? `管理画面リンク：${adminUrl}` : '',
    '',
    CHANGE_NOTE,
  ].filter((l) => l !== '');
  return lines.join('\n');
}

/**
 * 予約グループのカレンダー予定を最新内容で作成/更新する（リッチ出力・#54関連）。
 * - 未作成の行は insert、作成済みの行は内容を patch（支払い状況の反映など）。
 * - 予約作成時・入金確定時・本予約化時に呼ぶ。キャンセルは対象外。
 */
export async function syncBookingCalendarEvents(env: Env, groupId: string, origin: string): Promise<{ warning?: string }> {
  if (!gcalConfigured(env)) return {};
  const data = await getBookingCalendarData(env.DB, groupId);
  if (!data || !data.calendarId || data.status === 'cancelled') return {};
  const tentative = data.status === 'tentative';
  const summary = buildCalendarTitle(data, tentative);
  const description = buildCalendarDescription(data, origin);
  try {
    const updates: D1PreparedStatement[] = [];
    for (const r of data.rows) {
      if (r.google_event_id) {
        await patchEventContent(env, data.calendarId, r.google_event_id, { summary, description });
      } else {
        const ev = await insertEvent(env, data.calendarId, {
          summary,
          description,
          startISO: toJstRfc3339(r.date, r.start_time),
          endISO: toJstRfc3339(r.date, r.end_time),
        });
        updates.push(env.DB.prepare('UPDATE bookings SET google_event_id = ? WHERE id = ?').bind(ev.id, r.id));
      }
    }
    if (updates.length) await env.DB.batch(updates);
    return {};
  } catch (err) {
    return { warning: `Googleカレンダー同期に失敗しました（予約は成立しています）: ${(err as Error).message}` };
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
