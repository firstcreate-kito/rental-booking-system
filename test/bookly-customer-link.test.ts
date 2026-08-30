// @ts-nocheck 実SQLエンジン（node:sqlite）で本番の runBooklyImport→runCustomerLink を動かす検証。
// 本プロジェクトは types:["@cloudflare/workers-types"] で node 型を持たないため当ファイルのみ型チェック対象外。
/**
 * 移行顧客の会員化＋紐付け（案A）の実証。件数は同梱データから動的に算出（データ再生成でも壊れない）。
 *   1) 全枠を取り込む（gcal鍵なし＝Google連携は自動でスキップ、D1のみ）
 *   2) 会員化＋紐付けを実行 → ロースター人数を作成・顧客/チケット枠に customer_id 付与
 *   3) 冪等（再実行で作成0・紐付け0）
 *   4) 紐付け取り消し（unlink）で customer_id が外れ、会員は残る
 * これによりマイページで移行予約が見える＝案Aが成立することを担保する。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { runBooklyImport, BOOKLY_TARGET_SPACES } from '../src/lib/bookly-import';
import { runCustomerLink, unlinkBooklyCustomers, loadBooklyCustomers } from '../src/lib/bookly-customer-link';

// node:sqlite は Node 22+ のみ。無い環境（CIのNode20等）は describe.skip で丸ごとスキップ。
let DatabaseSync;
let sqliteOk = true;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { sqliteOk = false; }
const d = sqliteOk ? describe : describe.skip;

// prepared statement をSQLごとにキャッシュ（node:sqlite の未finalize蓄積を避ける＝大量取り込みでも安定）
class Stmt {
  params = [];
  constructor(stmt) { this.stmt = stmt; }
  bind(...a) { this.params = a; return this; }
  async all() { return { results: this.stmt.all(...this.params) }; }
  async first() { return this.stmt.get(...this.params) ?? null; }
  async run() { return { meta: this.stmt.run(...this.params) }; }
}
class D1 {
  db = new DatabaseSync(':memory:');
  cache = new Map();
  _stmt(sql) { let s = this.cache.get(sql); if (!s) { s = this.db.prepare(sql); this.cache.set(sql, s); } return s; }
  prepare(sql) { return new Stmt(this._stmt(sql)); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try { const o = []; for (const s of stmts) o.push(await s.run()); this.db.exec('COMMIT'); return o; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

let db, env;
// 期待値は同梱データから動的に算出（データ再生成でも壊れない）。
const EXPECT_CUSTOMERS = loadBooklyCustomers().length; // ロースター人数（例:52）
const _slotsData = createRequire(import.meta.url)('../src/data/bookly-slots.json');
const _allSlots = _slotsData.slots || _slotsData;
const _roster = new Set(loadBooklyCustomers().map((c) => String(c.email || '').toLowerCase()));
const EXPECT_TOTAL = _allSlots.length; // 取り込み総枠数（例:325）
// 会員化で customer_id が付くグループ＝顧客/チケット枠のうちロースターにメール一致するもの（例:158）
const EXPECT_GROUPS_LINKED = _allSlots.filter(
  (s) => (s.category === 'customer' || s.category === 'customer_ticket') && s.email && _roster.has(String(s.email).toLowerCase()),
).length;

if (sqliteOk) beforeAll(async () => {
  db = new D1();
  env = { DB: db }; // GOOGLE_SA_* 無し → gcalConfigured=false → カレンダー処理はスキップ
  db.db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT, is_active INTEGER DEFAULT 1, google_calendar_id TEXT);
    CREATE TABLE calendar_holidays (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, name TEXT, type TEXT);
    CREATE TABLE customers (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT, is_registered INTEGER DEFAULT 0,
      contact_name TEXT, phone TEXT, status_id TEXT DEFAULT 'general', created_at TEXT);
    CREATE TABLE booking_groups (id TEXT PRIMARY KEY, booking_number TEXT UNIQUE, customer_id TEXT, space_id TEXT,
      event_name TEXT, purpose TEXT, headcount INTEGER, total_amount INTEGER, original_total_amount INTEGER,
      original_date TEXT, status TEXT, source TEXT, note TEXT, created_at TEXT,
      reminder_3d_sent_at TEXT, reminder_1d_sent_at TEXT, unpaid_reminder_sent_at TEXT, thanks_sent_at TEXT, points_awarded_at TEXT);
    CREATE TABLE bookings (id TEXT PRIMARY KEY, group_id TEXT, space_id TEXT, date TEXT, start_time TEXT, end_time TEXT,
      billable_hours INTEGER, billing_mode TEXT, is_residence INTEGER, rate INTEGER, price INTEGER, status TEXT,
      source TEXT, google_event_id TEXT);
    CREATE TABLE bookly_imports (bookly_key TEXT PRIMARY KEY, group_id TEXT, space_id TEXT, date TEXT, start_time TEXT,
      category TEXT, bookly_id TEXT, created_at TEXT);
  `);
  const ins = db.db.prepare(`INSERT INTO spaces (id,name,is_active,google_calendar_id) VALUES (?,?,1,NULL)`);
  for (const id of BOOKLY_TARGET_SPACES) ins.run(id, id);
  // 全枠を取り込む（Google連携なしなのでD1のみ）。1回あたり最大300件のバッチ上限があるので remaining=0 まで回す（UIと同じ）。
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const r = await runBooklyImport(env, { dryRun: false, limit: 300, origin: 'x' });
    total += r.processed;
    if (r.remaining <= 0) break;
  }
  expect(total).toBe(EXPECT_TOTAL);
});

const cnt = (sql) => db.db.prepare(sql).get().c;

d('移行顧客の会員化＋紐付け（案A）', () => {
  it('プレビュー（ドライラン）：ロースター人数・対象グループが分かる（書き込まない）', async () => {
    const before = cnt(`SELECT COUNT(*) c FROM customers`);
    const p = await runCustomerLink(env, { dryRun: true });
    console.log('[preview]', JSON.stringify({ roster: p.rosterSize, create: p.customersCreated, link: p.groupsLinked }));
    expect(p.rosterSize).toBe(EXPECT_CUSTOMERS);
    expect(p.customersCreated).toBe(EXPECT_CUSTOMERS);
    expect(p.groupsLinked).toBe(EXPECT_GROUPS_LINKED);
    expect(cnt(`SELECT COUNT(*) c FROM customers`)).toBe(before); // 未書き込み
  });

  it('本実行：会員化し、移行グループに customer_id を付与', async () => {
    const r = await runCustomerLink(env, { dryRun: false });
    console.log('[link]', JSON.stringify({ created: r.customersCreated, linked: r.groupsLinked }));
    expect(r.customersCreated).toBe(EXPECT_CUSTOMERS);
    expect(r.groupsLinked).toBe(EXPECT_GROUPS_LINKED);
    expect(cnt(`SELECT COUNT(*) c FROM customers`)).toBe(EXPECT_CUSTOMERS);
    expect(cnt(`SELECT COUNT(*) c FROM booking_groups WHERE source='bookly' AND customer_id IS NOT NULL`)).toBe(EXPECT_GROUPS_LINKED);
    // ブロック等（顧客不在）には customer_id が付かない
    expect(cnt(`SELECT COUNT(*) c FROM booking_groups WHERE source='bookly' AND customer_id IS NULL`)).toBe(EXPECT_TOTAL - EXPECT_GROUPS_LINKED);
  });

  it('冪等：再実行しても新規作成0・紐付け0（既存・紐付済は維持）', async () => {
    const r = await runCustomerLink(env, { dryRun: false });
    expect(r.customersCreated).toBe(0);
    expect(r.customersExisting).toBe(EXPECT_CUSTOMERS);
    expect(r.groupsLinked).toBe(0);
    expect(r.groupsAlreadyLinked).toBe(EXPECT_GROUPS_LINKED);
  });

  it('移行予約は自動処理の対象外（ポイント付与・お礼・リマインダー・未入金の印が入っている）', () => {
    const n = db.db.prepare(`SELECT COUNT(*) c FROM booking_groups WHERE source='bookly'
      AND points_awarded_at IS NOT NULL AND thanks_sent_at IS NOT NULL
      AND reminder_3d_sent_at IS NOT NULL AND reminder_1d_sent_at IS NOT NULL AND unpaid_reminder_sent_at IS NOT NULL`).get().c;
    const total = db.db.prepare(`SELECT COUNT(*) c FROM booking_groups WHERE source='bookly'`).get().c;
    expect(n).toBe(total); // 全枠が cron 対象外
  });

  it('紐付けした会員はメールでログイン可能な形（is_registered=1・パスワードなし）', () => {
    const row = db.db.prepare(`SELECT COUNT(*) c FROM customers WHERE is_registered=1 AND password_hash IS NULL`).get().c;
    expect(row).toBe(EXPECT_CUSTOMERS);
  });

  it('unlink：紐付けだけ外れて会員は残る（再取り込みや作り直しに使える）', async () => {
    const u = await unlinkBooklyCustomers(env);
    expect(u.groupsUnlinked).toBe(EXPECT_GROUPS_LINKED);
    expect(cnt(`SELECT COUNT(*) c FROM booking_groups WHERE source='bookly' AND customer_id IS NOT NULL`)).toBe(0);
    expect(cnt(`SELECT COUNT(*) c FROM customers`)).toBe(EXPECT_CUSTOMERS); // 会員は残る
  });
});
