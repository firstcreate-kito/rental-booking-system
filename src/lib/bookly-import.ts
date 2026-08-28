/**
 * 公開切替：Bookly既存予約の「枠」インポート。
 *
 * 目的：ドメイン切替でBooklyが外れると、マスター台帳であるGoogleカレンダー上の
 *   Bookly由来＋手入力の予定が消える。そこで Bookly を外す“前”に、各枠を
 *   「新システム所有のGoogle予定 ＋ D1の本予約枠」として先に作っておく。
 *   → Bookly離脱後も新システムの予定が残り、枠が空きに戻らない（＝二重予約を防ぐ）。
 *
 * 設計上の要点：
 *   - 取り込み元は `src/data/bookly-slots.json`（scripts/bookly-parse.mjs で生成・8スペース/OTA除外/重複排除済み）。
 *   - すべて status='confirmed' / source='bookly'（ご指定：手動ブロックも本予約枠として投入）。明細は持たない（枠のみ）。
 *   - **競合チェックはスキップ**する。取り込み時点ではBooklyの予定がまだカレンダーを埋めているため、
 *     通常の checkCalendarConflict を通すと全件「埋まっている」と誤判定される。重複排除は事前（JSON生成時）に完了済み。
 *   - 冪等：bookly_imports(bookly_key) に記録し、再実行は取り込み済みをスキップ。バッチ（limit）対応で
 *     Workerの時間・サブリクエスト上限に配慮。
 *   - Google予定はカレンダーID未設定のスペースでは作られず、D1枠だけ作成（ステージングのテストカレンダー運用に配慮）。
 *
 * ロールバック：source='bookly' の予約のGoogle予定を削除→行削除→bookly_imports を掃除（別途手順）。
 */
import type { Env } from '../types';
import { getSpaceById } from '../db/repository';
import { gcalConfigured } from './gcal';
import { syncBookingCalendarEvents, deleteBookingFromCalendar } from './gcal-sync';
import { nowJST, todayYmdJST } from './clock';
import slotsData from '../data/bookly-slots.json';

export interface BooklySlot {
  booklyKey: string;
  spaceId: string;
  date: string;        // YYYY-MM-DD
  startTime: string;   // HH:MM
  endTime: string;     // HH:MM
  durationMin: number;
  category: 'customer' | 'customer_ticket' | 'block' | 'mirror';
  label: string;
  booklyId: string;
  booklyStaff: string;
}

interface SlotsFile {
  meta: Record<string, unknown>;
  slots: BooklySlot[];
}

export function loadBooklySlots(): BooklySlot[] {
  return (slotsData as unknown as SlotsFile).slots ?? [];
}

export interface BooklyImportOptions {
  dryRun: boolean;
  /** 1回で処理する最大件数（Worker上限対策）。既定 60。 */
  limit?: number;
  /** 特定スペースだけに絞る（ステージング予行演習用。例 ['meieki-free']）。 */
  spaceIds?: string[];
  /** Google予定の説明文リンク用オリジン。 */
  origin: string;
}

export interface BooklyImportResult {
  dryRun: boolean;
  gcalConfigured: boolean;
  total: number;            // 対象スロット総数（spaceIdsで絞った後）
  alreadyImported: number;  // 既に取り込み済み
  pending: number;          // 未取り込み
  processed: number;        // 今回作成した枠数
  calendarCreated: number;  // 今回Google予定を作れた数
  remaining: number;        // 今回の後に残る未取り込み
  perSpacePending: Record<string, number>;
  perSpaceProcessed: Record<string, number>;
  noCalendarSpaces: string[]; // カレンダーID未設定でGoogle予定を作らなかったスペース
  warnings: string[];
}

const BILLING_MODE = 'hourly';

/** durationMin から billable_hours（整数・最低1）を算出 */
export function billableHours(min: number): number {
  return Math.max(1, Math.round((Number(min) || 0) / 60));
}

/** 取り込み対象の8スペース（新システムに登録済み＝現在Booklyを使っている施設） */
export const BOOKLY_TARGET_SPACES = [
  'albe-hall-nagoya',
  'meieki-exercise',
  'meieki-washitsu',
  'meieki-free',
  'higashibetsuin-piano-24h',
  'meieki-piano-a',
  'meieki-piano-b',
  'kitaokazaki-warehouse',
] as const;

/**
 * インポート実行（dryRun / 本実行 共通）。
 * dryRun のときは一切書き込まず、件数と内訳だけ返す。
 */
export async function runBooklyImport(env: Env, opts: BooklyImportOptions): Promise<BooklyImportResult> {
  const db = env.DB;
  const limit = Math.max(1, Math.min(opts.limit ?? 60, 300));
  const spaceFilter = opts.spaceIds && opts.spaceIds.length > 0 ? new Set(opts.spaceIds) : null;

  let slots = loadBooklySlots();
  if (spaceFilter) slots = slots.filter((s) => spaceFilter.has(s.spaceId));

  // 取り込み済みキー
  const doneKeys = new Set<string>();
  {
    const { results } = await db.prepare('SELECT bookly_key FROM bookly_imports').all<{ bookly_key: string }>();
    for (const r of results ?? []) doneKeys.add(r.bookly_key);
  }

  const pending = slots.filter((s) => !doneKeys.has(s.booklyKey));
  const perSpacePending: Record<string, number> = {};
  for (const s of pending) perSpacePending[s.spaceId] = (perSpacePending[s.spaceId] ?? 0) + 1;

  const result: BooklyImportResult = {
    dryRun: opts.dryRun,
    gcalConfigured: gcalConfigured(env),
    total: slots.length,
    alreadyImported: slots.length - pending.length,
    pending: pending.length,
    processed: 0,
    calendarCreated: 0,
    remaining: pending.length,
    perSpacePending,
    perSpaceProcessed: {},
    noCalendarSpaces: [],
    warnings: [],
  };

  if (opts.dryRun) return result;

  const batch = pending.slice(0, limit);
  const ymd = todayYmdJST();
  const now = nowJST();
  // 連番はローカルカウンタで進める（UNIQUE衝突時のみ再取得）
  let seq = await peekSeq(db, ymd);
  const noCal = new Set<string>();

  for (const slot of batch) {
    const space = await getSpaceById(db, slot.spaceId);
    if (!space || !space.is_active) {
      result.warnings.push(`スペース未検出/無効のためスキップ: ${slot.spaceId} (${slot.booklyKey})`);
      continue;
    }

    const groupId = crypto.randomUUID();
    const bookingId = crypto.randomUUID();
    const eventName = slot.label || 'Bookly移行枠';
    const bh = billableHours(slot.durationMin);

    // group + booking + bookly_imports を1バッチで（原子的）。booking_number はUNIQUE衝突で再試行。
    let ok = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const bookingNumber = `${ymd}-${String(seq).padStart(3, '0')}`;
      try {
        await db.batch([
          db.prepare(
            `INSERT INTO booking_groups
             (id, booking_number, customer_id, space_id, event_name, total_amount, original_total_amount, original_date, status, source, note, created_at)
             VALUES (?, ?, NULL, ?, ?, 0, 0, ?, 'confirmed', 'bookly', ?, ?)`,
          ).bind(groupId, bookingNumber, slot.spaceId, eventName, slot.date, `Bookly移行 (${slot.category})`, now),
          db.prepare(
            `INSERT INTO bookings
             (id, group_id, space_id, date, start_time, end_time, billable_hours, billing_mode, is_residence, rate, price, status, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, 'confirmed', 'bookly')`,
          ).bind(bookingId, groupId, slot.spaceId, slot.date, slot.startTime, slot.endTime, bh, BILLING_MODE),
          db.prepare(
            `INSERT INTO bookly_imports (bookly_key, group_id, space_id, date, start_time, category, bookly_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(slot.booklyKey, groupId, slot.spaceId, slot.date, slot.startTime, slot.category, slot.booklyId, now),
        ]);
        seq++;
        ok = true;
        break;
      } catch (err) {
        const msg = (err as Error).message || '';
        if (msg.includes('bookly_imports') || (msg.includes('UNIQUE') && msg.includes('bookly_key'))) {
          // 競合で既に取り込み済み（別バッチ等）→ スキップ
          ok = false;
          break;
        }
        if (msg.includes('UNIQUE') && attempt < 5) {
          seq = await peekSeq(db, ymd); // booking_number 衝突 → 採番し直し
          continue;
        }
        result.warnings.push(`挿入失敗 ${slot.booklyKey}: ${msg}`);
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    result.processed++;
    result.perSpaceProcessed[slot.spaceId] = (result.perSpaceProcessed[slot.spaceId] ?? 0) + 1;

    // Google予定を作成（カレンダーID未設定なら no-op）。失敗しても枠は成立。
    if (!space.google_calendar_id) {
      noCal.add(slot.spaceId);
    } else if (result.gcalConfigured) {
      const res = await syncBookingCalendarEvents(env, groupId, opts.origin);
      if (res.warning) result.warnings.push(`${slot.booklyKey}: ${res.warning}`);
      else result.calendarCreated++;
    }
  }

  result.remaining = pending.length - result.processed;
  result.noCalendarSpaces = [...noCal];
  return result;
}

async function peekSeq(db: D1Database, ymd: string): Promise<number> {
  const row = await db
    .prepare(`SELECT booking_number FROM booking_groups WHERE booking_number LIKE ? ORDER BY booking_number DESC LIMIT 1`)
    .bind(`${ymd}-%`)
    .first<{ booking_number: string }>();
  if (!row) return 1;
  return Number(row.booking_number.split('-')[1] ?? '0') + 1;
}

export interface BooklyRollbackResult {
  deleted: number;            // 削除した枠数
  calendarDeleted: number;    // 削除したGoogle予定数
  perSpace: Record<string, number>;
  warnings: string[];
}

/**
 * 取り込みの取り消し（ロールバック）。source='bookly' の予約グループと、そのGoogle予定、
 * bookly_imports の記録を削除する。spaceIds 指定でスペースを絞れる（未指定は全部）。
 * 取り消し後は再取り込み可能（bookly_imports が消えるため）。
 */
export async function rollbackBooklyImport(
  env: Env,
  opts: { spaceIds?: string[] },
): Promise<BooklyRollbackResult> {
  const db = env.DB;
  const filter = opts.spaceIds && opts.spaceIds.length > 0 ? opts.spaceIds : null;

  // bookly由来のグループを列挙（source='bookly' の二重確認込み）
  const sql = filter
    ? `SELECT bi.group_id AS group_id, bi.space_id AS space_id
         FROM bookly_imports bi JOIN booking_groups g ON g.id = bi.group_id
        WHERE g.source = 'bookly' AND bi.space_id IN (${filter.map(() => '?').join(',')})`
    : `SELECT bi.group_id AS group_id, bi.space_id AS space_id
         FROM bookly_imports bi JOIN booking_groups g ON g.id = bi.group_id
        WHERE g.source = 'bookly'`;
  const stmt = filter ? db.prepare(sql).bind(...filter) : db.prepare(sql);
  const { results } = await stmt.all<{ group_id: string; space_id: string }>();
  const groups = results ?? [];

  const result: BooklyRollbackResult = { deleted: 0, calendarDeleted: 0, perSpace: {}, warnings: [] };
  const calBySpace = new Map<string, string | null>();

  for (const g of groups) {
    // スペースのカレンダーID（キャッシュ）
    if (!calBySpace.has(g.space_id)) {
      const sp = await getSpaceById(db, g.space_id);
      calBySpace.set(g.space_id, sp?.google_calendar_id ?? null);
    }
    const calendarId = calBySpace.get(g.space_id) ?? null;

    // このグループの Google予定を削除
    const { results: brows } = await db
      .prepare(`SELECT google_event_id FROM bookings WHERE group_id = ? AND google_event_id IS NOT NULL`)
      .bind(g.group_id)
      .all<{ google_event_id: string }>();
    const eventIds = (brows ?? []).map((r) => r.google_event_id).filter(Boolean);
    if (calendarId && gcalConfigured(env) && eventIds.length) {
      try {
        await deleteBookingFromCalendar(env, calendarId, eventIds);
        result.calendarDeleted += eventIds.length;
      } catch (err) {
        result.warnings.push(`Google予定の削除に失敗（枠は削除します）group=${g.group_id}: ${(err as Error).message}`);
      }
    }

    // D1から削除（bookings → booking_groups → bookly_imports）
    await db.batch([
      db.prepare(`DELETE FROM bookings WHERE group_id = ?`).bind(g.group_id),
      db.prepare(`DELETE FROM booking_groups WHERE id = ? AND source = 'bookly'`).bind(g.group_id),
      db.prepare(`DELETE FROM bookly_imports WHERE group_id = ?`).bind(g.group_id),
    ]);
    result.deleted++;
    result.perSpace[g.space_id] = (result.perSpace[g.space_id] ?? 0) + 1;
  }
  return result;
}
