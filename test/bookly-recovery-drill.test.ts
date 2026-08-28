// @ts-nocheck 実SQLエンジン（node:sqlite・実験的ビルトイン）を使うテスト専用の復旧ドリル。
// 本プロジェクトは types:["@cloudflare/workers-types"] で node 型を持たないため、当ファイルのみ型チェック対象外。
// 実行時の健全性は vitest（全ステップ緑）で担保する。
/**
 * 【ステージング復旧リハーサル（自動実証）】公開切替：Bookly切断で最悪ケース（Googleカレンダー上の
 * 移行イベントが“全消し”される）を再現し、ロールバック→再取り込みで完全復元できることを、
 * 本番と同一の runBooklyImport / rollbackBooklyImport を実SQL（node:sqlite）上で動かして実証する。
 *
 * 実証する3点：
 *   (a) 移行データの“正”は Googleカレンダーではなく bookly-slots.json ＋ D1 である
 *       → Google全消し後も D1 は無傷。
 *   (b) 切断で全消しされても、ロールバック→再取り込みで枠・Google予定・サイネージ本文まで完全復元できる。
 *   (c) ロールバックはGoogle予定が既に消えている（=切断で削除済み・404）状況でも中断せず、
 *       D1 と bookly_imports を確実に掃除する（=再取り込み可能な状態に戻す）。
 *
 * 安全性：本番にもステージングの実カレンダーにも一切触れない。GoogleクライアントはフェイクでI/Oゼロ。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { loadBooklySlots } from '../src/lib/bookly-import';

// node:sqlite は Vite の解決を避けて実行時に require（実SQLエンジン）。
// Node 22+ でのみ利用可能なので、無い環境（CIのNode20等）では describe.skip で丸ごとスキップする。
let DatabaseSync: any;
let sqliteOk = true;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { sqliteOk = false; }
const d = sqliteOk ? describe : describe.skip;

// フェイクGoogleカレンダー（切断で「全消し」を再現するため、テスト本体から clear できるよう hoist）
const gcal = vi.hoisted(() => ({ cal: new Map<string, unknown>(), seq: { n: 0 } }));

vi.mock('../src/lib/gcal', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    gcalConfigured: () => true,
    insertEvent: async (_env: unknown, calendarId: string, body: Record<string, unknown>) => {
      const id = `evt_${++gcal.seq.n}`;
      gcal.cal.set(id, { calendarId, ...body });
      return { id };
    },
  };
});

vi.mock('../src/lib/gcal-sync', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    // 実際のGoogle削除と同じく、存在しないイベントIDの削除は 404 で throw する（切断で消えた後の再現）
    deleteBookingFromCalendar: async (_env: unknown, _calendarId: string, ids: string[]) => {
      for (const id of ids) {
        if (!gcal.cal.has(id)) throw new Error(`404 Not Found: event ${id} already deleted`);
        gcal.cal.delete(id);
      }
    },
  };
});

// import は vi.mock 定義の後（実行時解決）
const { runBooklyImport, rollbackBooklyImport } = await import('../src/lib/bookly-import');

// ---- D1Database 互換シム（node:sqlite の実SQLで本番コードをそのまま動かす）----
class Stmt {
  private params: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...args: unknown[]) { this.params = args; return this; }
  async all<T = unknown>() { return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[] }; }
  async first<T = unknown>() { return (this.db.prepare(this.sql).get(...(this.params as never[])) as T) ?? null; }
  async run() { return { meta: this.db.prepare(this.sql).run(...(this.params as never[])) }; }
}
class D1 {
  db = new DatabaseSync(':memory:');
  prepare(sql: string) { return new Stmt(this.db, sql); }
  async batch(stmts: Stmt[]) {
    this.db.exec('BEGIN');
    try {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e; // UNIQUE 制約違反などをそのまま伝播（本番コードが message を見て分岐）
    }
  }
}

const SPACE = 'meieki-free'; // ステージングで実際にテストカレンダー連動している施設
let db!: D1;
let env!: { DB: D1 };
const expectedSlots = loadBooklySlots().filter((s) => s.spaceId === SPACE);

function counts() {
  const g = (db.db.prepare(`SELECT COUNT(*) c FROM booking_groups WHERE source='bookly'`).get() as { c: number }).c;
  const b = (db.db.prepare(`SELECT COUNT(*) c FROM bookings WHERE source='bookly'`).get() as { c: number }).c;
  const bWithEvt = (db.db.prepare(`SELECT COUNT(*) c FROM bookings WHERE source='bookly' AND google_event_id IS NOT NULL`).get() as { c: number }).c;
  const imp = (db.db.prepare(`SELECT COUNT(*) c FROM bookly_imports`).get() as { c: number }).c;
  return { groups: g, bookings: b, bookingsWithEvent: bWithEvt, imports: imp, gcalEvents: gcal.cal.size };
}

if (sqliteOk) beforeAll(() => {
  db = new D1();
  env = { DB: db };
  db.db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT, is_active INTEGER DEFAULT 1, google_calendar_id TEXT);
    CREATE TABLE calendar_holidays (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, name TEXT, type TEXT);
    CREATE TABLE booking_groups (id TEXT PRIMARY KEY, booking_number TEXT UNIQUE, customer_id TEXT, space_id TEXT,
      event_name TEXT, purpose TEXT, headcount INTEGER, total_amount INTEGER, original_total_amount INTEGER,
      original_date TEXT, status TEXT, source TEXT, note TEXT, created_at TEXT);
    CREATE TABLE bookings (id TEXT PRIMARY KEY, group_id TEXT, space_id TEXT, date TEXT, start_time TEXT, end_time TEXT,
      billable_hours INTEGER, billing_mode TEXT, is_residence INTEGER, rate INTEGER, price INTEGER, status TEXT,
      source TEXT, google_event_id TEXT);
    CREATE TABLE bookly_imports (bookly_key TEXT PRIMARY KEY, group_id TEXT, space_id TEXT, date TEXT, start_time TEXT,
      category TEXT, bookly_id TEXT, created_at TEXT);
  `);
  // 対象スペースを active＋テストカレンダー付きで登録（Google予定作成の経路も通す）
  db.db.prepare(`INSERT INTO spaces (id,name,is_active,google_calendar_id) VALUES (?,?,1,?)`)
    .run(SPACE, '名駅フリースペース', `testcal-${SPACE}`);
});

d('ステージング復旧リハーサル：切断で全消し→ロールバック→再取り込みで完全復元', () => {
  it(`0) 前提：対象スロットが存在する（${SPACE}）`, () => {
    expect(expectedSlots.length).toBeGreaterThan(0);
    console.log(`\n[リハーサル] 対象スペース=${SPACE} / 移行スロット=${expectedSlots.length}件`);
  });

  it('1) 取り込み（本実行）：枠・Google予定・bookly_imports がすべて作成される', async () => {
    const dry = await runBooklyImport(env as never, { dryRun: true, spaceIds: [SPACE], origin: 'https://albe-booking-api-staging.rental-space-albe.workers.dev' });
    expect(dry.gcalConfigured).toBe(true);
    expect(dry.pending).toBe(expectedSlots.length);

    const res = await runBooklyImport(env as never, { dryRun: false, limit: 500, spaceIds: [SPACE], origin: 'https://albe-booking-api-staging.rental-space-albe.workers.dev' });
    expect(res.processed).toBe(expectedSlots.length);
    expect(res.calendarCreated).toBe(expectedSlots.length);
    expect(res.warnings).toEqual([]);

    const c = counts();
    console.log('[1] 取り込み後:', JSON.stringify(c));
    expect(c).toMatchObject({
      groups: expectedSlots.length,
      bookings: expectedSlots.length,
      bookingsWithEvent: expectedSlots.length,
      imports: expectedSlots.length,
      gcalEvents: expectedSlots.length,
    });
  });

  it('2) 切断シミュレーション：Google予定を“全消し”しても D1 は無傷（=正はD1/JSON側）', () => {
    gcal.cal.clear(); // Bookly切断でカレンダー上の移行イベントが全部消えた状態を再現
    const c = counts();
    console.log('[2] 全消し直後:', JSON.stringify(c));
    expect(c.gcalEvents).toBe(0);                       // Google側は空
    expect(c.bookings).toBe(expectedSlots.length);      // D1は無傷
    expect(c.bookingsWithEvent).toBe(expectedSlots.length); // google_event_id は残る（宙に浮いたID）
    expect(c.imports).toBe(expectedSlots.length);
  });

  it('3) 素の再取り込みは冪等ガードで全スキップ（=先にロールバックが必要と分かる）', async () => {
    const res = await runBooklyImport(env as never, { dryRun: false, limit: 500, spaceIds: [SPACE], origin: 'x' });
    console.log('[3] ロールバック無しの再取り込み: processed=', res.processed, ' alreadyImported=', res.alreadyImported);
    expect(res.processed).toBe(0);
    expect(res.alreadyImported).toBe(expectedSlots.length);
    expect(gcal.cal.size).toBe(0); // 何も作られない
  });

  it('4) ロールバック：Google予定が既に消えていても（404）中断せず D1/記録を完全に掃除', async () => {
    const res = await rollbackBooklyImport(env as never, { spaceIds: [SPACE] });
    console.log('[4] ロールバック:', JSON.stringify({ deleted: res.deleted, calendarDeleted: res.calendarDeleted, warnings: res.warnings.length }));
    expect(res.deleted).toBe(expectedSlots.length);
    expect(res.calendarDeleted).toBe(0);                 // 全部404だったので実削除0
    expect(res.warnings.length).toBe(expectedSlots.length); // 各件「削除失敗（枠は削除）」の警告＝404を握って継続した証拠
    const c = counts();
    expect(c).toMatchObject({ groups: 0, bookings: 0, imports: 0 }); // D1は空に戻る＝再取り込み可能
  });

  it('5) 再取り込み：枠・Google予定・bookly_imports が完全復元（=切断されても戻せる）', async () => {
    const res = await runBooklyImport(env as never, { dryRun: false, limit: 500, spaceIds: [SPACE], origin: 'https://booking.space-albe.com' });
    expect(res.processed).toBe(expectedSlots.length);
    expect(res.calendarCreated).toBe(expectedSlots.length);
    const c = counts();
    console.log('[5] 復元後:', JSON.stringify(c));
    expect(c).toMatchObject({
      groups: expectedSlots.length,
      bookings: expectedSlots.length,
      bookingsWithEvent: expectedSlots.length,
      imports: expectedSlots.length,
      gcalEvents: expectedSlots.length,
    });
  });

  it('6) 復元されたGoogle予定にサイネージ本文（タイトル/[キー]ブロック）が載っている', () => {
    const events = [...gcal.cal.values()] as Array<{ summary: string; description: string }>;
    expect(events.length).toBe(expectedSlots.length);
    // すべてサイネージ書式：タイトルに施設名（平日/土日祝）、本文に [スペース名]／[プラン] を含む
    for (const ev of events) {
      expect(ev.summary).toContain('名駅フリースペース');
      expect(ev.summary).toMatch(/（(平日|土日祝)）/);
      expect(ev.description).toContain('[スペース名]：');
      expect(ev.description).toContain('[プラン]：');
    }
    console.log('[6] サンプル タイトル:', events[0].summary);
    console.log('[6] サンプル 本文(先頭120字):', events[0].description.slice(0, 120).replace(/\n/g, ' / '));
  });
});
