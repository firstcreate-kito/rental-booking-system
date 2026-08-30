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
import type { BookingCalendarData } from '../db/repository';
import { getSpaceById, getHolidays } from '../db/repository';
import { gcalConfigured, insertEvent, toJstRfc3339, listEvents, deleteEvent } from './gcal';
import { deleteBookingFromCalendar, buildCalendarTitle, buildCalendarDescription } from './gcal-sync';
import { getDayType } from './calendar';
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
  // サイネージ用の詳細（案X）
  eventName?: string;
  purpose?: string | null;
  headcount?: number | null;
  options?: Array<{ name: string; quantity: number }>;
  customerName?: string;
  email?: string;
  phone?: string;
  amount?: number;
  repeatCustomer?: boolean;
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

/** 取り込み対象スペース（新システムに登録済み＝Booklyで予約を受けていた施設） */
export const BOOKLY_TARGET_SPACES = [
  'albe-hall-nagoya',
  'meieki-exercise',
  'meieki-washitsu',
  'meieki-free',
  'higashibetsuin-piano-24h',
  'meieki-piano-a',
  'meieki-piano-b',
  'kitaokazaki-warehouse',
  // 追加移行（当初は対象外にしていたが Bookly で予約を受けていた）。本番D1の実スペースID。
  '0ccfadae-4f59-427d-b5b6-4bdfd3fcd470', // 栄チャペルスペース
  '6962febb-0538-4b8c-b04c-7e93285e4386', // 栄神殿スペース
] as const;

/**
 * インポート実行（dryRun / 本実行 共通）。
 * dryRun のときは一切書き込まず、件数と内訳だけ返す。
 */
export async function runBooklyImport(env: Env, opts: BooklyImportOptions): Promise<BooklyImportResult> {
  const db = env.DB;
  // 1回の処理件数は控えめに上限（各Google予定作成＝1サブリクエスト＋D1書込。Worker実行時間/
  // サブリクエスト上限に触れて「作成できたのに google_event_id 記録漏れ＝孤児化」するのを防ぐ）。
  // UI は remaining=0 まで自動ループするため、小さめでも取り込みは完了する。
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 40));
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
  // 平日/土日祝の判定用に、対象日の祝日をまとめて取得
  const batchDates = batch.map((s) => s.date).sort();
  const holidays = batchDates.length ? await getHolidays(db, batchDates[0], batchDates[batchDates.length - 1]) : new Map();

  for (const slot of batch) {
    const space = await getSpaceById(db, slot.spaceId);
    if (!space || !space.is_active) {
      result.warnings.push(`スペース未検出/無効のためスキップ: ${slot.spaceId} (${slot.booklyKey})`);
      continue;
    }

    const groupId = crypto.randomUUID();
    const bookingId = crypto.randomUUID();
    const eventName = slot.eventName || slot.label || 'Bookly移行枠';
    const amount = Math.max(0, Math.round(slot.amount ?? 0));
    const bh = billableHours(slot.durationMin);

    // group + booking + bookly_imports を1バッチで（原子的）。booking_number はUNIQUE衝突で再試行。
    let ok = false;
    let bookingNumber = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      bookingNumber = `${ymd}-${String(seq).padStart(3, '0')}`;
      try {
        await db.batch([
          db.prepare(
            // 移行予約は新システムの自動処理（リマインダー3日/1日前・未入金・お礼・ポイント付与）の対象外にする。
            // 旧Booklyで精算済み＝新システムのポイント付与や自動メールを走らせないため、各 *_sent_at / points_awarded_at を
            // 取り込み時点で「処理済み」にしておく（各cronは IS NULL のみ対象なので確実にスキップされる）。
            `INSERT INTO booking_groups
             (id, booking_number, customer_id, space_id, event_name, purpose, headcount, total_amount, original_total_amount, original_date, status, source, note, created_at,
              reminder_3d_sent_at, reminder_1d_sent_at, unpaid_reminder_sent_at, thanks_sent_at, points_awarded_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'bookly', ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(groupId, bookingNumber, slot.spaceId, eventName, slot.purpose ?? null, slot.headcount ?? null, amount, amount, slot.date, `Bookly移行 (${slot.category})`, now, now, now, now, now, now),
          db.prepare(
            `INSERT INTO bookings
             (id, group_id, space_id, date, start_time, end_time, billable_hours, billing_mode, is_residence, rate, price, status, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 'confirmed', 'bookly')`,
          ).bind(bookingId, groupId, slot.spaceId, slot.date, slot.startTime, slot.endTime, bh, BILLING_MODE, amount),
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
    // サイネージ用にBookly由来の詳細（イベント名・利用目的・人数・オプション・お名前・金額）を本文へ反映（案X）。
    if (!space.google_calendar_id) {
      noCal.add(slot.spaceId);
    } else if (result.gcalConfigured) {
      try {
        const suffix = getDayType(slot.date, holidays as ReadonlyMap<string, 'holiday' | 'custom' | 'closed'>) === 'weekend' ? '土日祝' : '平日';
        const spaceLabel = space.name ? `${space.name}（${suffix}）` : '';
        const calData: BookingCalendarData = {
          calendarId: space.google_calendar_id,
          bookingNumber,
          status: 'confirmed',
          spaceName: space.name,
          customerName: slot.customerName || slot.eventName || slot.label || 'お客様',
          phone: slot.phone || null,
          email: slot.email || null,
          company: null,
          eventName: slot.eventName || slot.label,
          purpose: slot.purpose ?? null,
          headcount: slot.headcount ?? null,
          total: amount,
          paymentStatus: 'paid',
          paymentMethod: null,
          repeatCustomer: !!slot.repeatCustomer,
          options: slot.options ?? [],
          rows: [{ id: bookingId, date: slot.date, start_time: slot.startTime, end_time: slot.endTime, google_event_id: null }],
        };
        const summary = buildCalendarTitle(calData, false, spaceLabel);
        const description = buildCalendarDescription(calData, opts.origin, spaceLabel);
        const ev = await insertEvent(env, space.google_calendar_id, {
          summary,
          description,
          startISO: toJstRfc3339(slot.date, slot.startTime),
          endISO: toJstRfc3339(slot.date, slot.endTime),
        });
        await db.prepare('UPDATE bookings SET google_event_id = ? WHERE id = ?').bind(ev.id, bookingId).run();
        result.calendarCreated++;
      } catch (err) {
        result.warnings.push(`${slot.booklyKey}: Googleカレンダー作成失敗（枠は成立）: ${(err as Error).message}`);
      }
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

export interface OrphanCleanupResult {
  scanned: number;   // 走査した「当システム(SA)作成」イベント数
  orphans: number;   // 孤児と判定した数
  deleted: number;   // 実削除数（dryRun は 0）
  perSpace: Record<string, number>;
  samples: Array<{ spaceId: string; bookingNumber: string; summary: string; date: string }>;
  warnings: string[];
}

/**
 * 孤児Google予定の掃除。取り込み等で当システムが作成した予定（作成者＝GOOGLE_SA_EMAIL）のうち、
 * 説明文の管理リンク（booking=YYYYMMDD-連番）の予約番号が D1(booking_groups) に存在しない
 * ＝ロールバック等で親レコードが消えたのに残った“孤児”だけを、一覧（dryRun）／削除する。
 *   - 作成者がSA以外（OTA・旧Bookly＝オーナー作成）の予定は一切触らない（誤削除防止）。
 *   - 予約番号を特定できない予定も触らない（安全側）。
 *   - 走査は本日以降のみ（過去は対象外）。
 */
export async function cleanupOrphanCalendarEvents(
  env: Env,
  opts: { dryRun: boolean; spaceIds?: string[] },
): Promise<OrphanCleanupResult> {
  const db = env.DB;
  const result: OrphanCleanupResult = { scanned: 0, orphans: 0, deleted: 0, perSpace: {}, samples: [], warnings: [] };
  if (!gcalConfigured(env)) { result.warnings.push('Google連携が未設定のためスキップ'); return result; }
  const saEmail = (env.GOOGLE_SA_EMAIL ?? '').trim().toLowerCase();
  if (!saEmail) { result.warnings.push('GOOGLE_SA_EMAIL 未設定のため判定不可（安全のため中止）'); return result; }

  const targets = opts.spaceIds && opts.spaceIds.length > 0
    ? opts.spaceIds.filter((s) => (BOOKLY_TARGET_SPACES as readonly string[]).includes(s))
    : [...BOOKLY_TARGET_SPACES];

  const now = Date.now();
  const timeMin = new Date(now - 24 * 3600 * 1000).toISOString();
  const timeMax = new Date(now + 400 * 24 * 3600 * 1000).toISOString();
  const reBooking = /booking=(\d{8}-\d+)/;

  for (const spaceId of targets) {
    const sp = await getSpaceById(db, spaceId);
    const calendarId = sp?.google_calendar_id ?? null;
    if (!calendarId) continue;
    let events;
    try {
      events = await listEvents(env, calendarId, timeMin, timeMax, 2500);
    } catch (err) {
      result.warnings.push(`一覧取得失敗 ${spaceId}: ${(err as Error).message}`);
      continue;
    }
    for (const ev of events) {
      if ((ev.creatorEmail ?? '').trim().toLowerCase() !== saEmail) continue; // 当システム(SA)作成のみ
      result.scanned++;
      const m = (ev.description ?? '').match(reBooking);
      if (!m) continue; // 予約番号を特定できない＝触らない
      const bookingNumber = m[1];
      const row = await db
        .prepare(`SELECT 1 AS ok FROM booking_groups WHERE booking_number = ? LIMIT 1`)
        .bind(bookingNumber)
        .first<{ ok: number }>();
      if (row) continue; // D1に存在＝稼働中。保持
      result.orphans++;
      result.perSpace[spaceId] = (result.perSpace[spaceId] ?? 0) + 1;
      if (result.samples.length < 20) {
        result.samples.push({ spaceId, bookingNumber, summary: ev.summary ?? '', date: (ev.start ?? '').slice(0, 10) });
      }
      if (!opts.dryRun) {
        try {
          await deleteEvent(env, calendarId, ev.id);
          result.deleted++;
        } catch (err) {
          result.warnings.push(`削除失敗 ${spaceId} ${bookingNumber}: ${(err as Error).message}`);
        }
      }
    }
  }
  return result;
}
