// @ts-nocheck 予約一覧の「未入金のみ」フィルタ（listBookingsForAdmin）を検証。
// payment='unpaid' で、本予約(confirmed)かつ payment_status='unpaid' の行だけを、
// 利用日に関わらず（過去日も含めて）返すことを確認する。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

let DatabaseSync: any;
let sqliteOk = true;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { sqliteOk = false; }
const d = sqliteOk ? describe : describe.skip;

const { listBookingsForAdmin } = await import('../src/db/repository');

class Stmt {
  private params: unknown[] = [];
  constructor(private db: any, private sql: string) {}
  bind(...args: unknown[]) { this.params = args; return this; }
  async all<T = unknown>() { return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[] }; }
  async first<T = unknown>() { return (this.db.prepare(this.sql).get(...(this.params as never[])) as T) ?? null; }
  async run() { return { meta: this.db.prepare(this.sql).run(...(this.params as never[])) }; }
}
class D1 {
  db = new DatabaseSync(':memory:');
  prepare(sql: string) { return new Stmt(this.db, sql); }
}

function makeDb() {
  const db = new D1();
  db.db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT);`);
  db.db.exec(`CREATE TABLE customers (id TEXT PRIMARY KEY, contact_name TEXT, company_name TEXT);`);
  db.db.exec(`CREATE TABLE booking_groups (id TEXT PRIMARY KEY, booking_number TEXT, event_name TEXT,
    source TEXT, customer_id TEXT, payment_method TEXT, payment_status TEXT);`);
  db.db.exec(`CREATE TABLE bookings (id TEXT PRIMARY KEY, group_id TEXT, space_id TEXT,
    date TEXT, start_time TEXT, end_time TEXT, status TEXT, price REAL, billing_mode TEXT);`);
  // 追加請求バッジ用の集計（kind='additional'）に必要。空でも存在すればサブクエリが通る。
  db.db.exec(`CREATE TABLE booking_payments (id TEXT PRIMARY KEY, group_id TEXT, kind TEXT DEFAULT 'booking', status TEXT DEFAULT 'pending');`);
  db.db.prepare("INSERT INTO spaces VALUES ('s1','名駅フリースペース')").run();
  db.db.prepare("INSERT INTO customers VALUES ('c1','山田太郎','')").run();
  // g1: 本予約・未入金・未来日 → 対象
  db.db.prepare("INSERT INTO booking_groups VALUES ('g1','B001','A','web','c1','bank_transfer','unpaid')").run();
  db.db.prepare("INSERT INTO bookings VALUES ('b1','g1','s1','2099-01-10','10:00','12:00','confirmed',5000,'hourly')").run();
  // g2: 本予約・未入金・過去日 → 対象（過去の入金漏れも拾う）
  db.db.prepare("INSERT INTO booking_groups VALUES ('g2','B002','B','web','c1','bank_transfer','unpaid')").run();
  db.db.prepare("INSERT INTO bookings VALUES ('b2','g2','s1','2000-01-05','10:00','12:00','confirmed',5000,'hourly')").run();
  // g3: 本予約・入金済み → 対象外
  db.db.prepare("INSERT INTO booking_groups VALUES ('g3','B003','C','web','c1','stripe','paid')").run();
  db.db.prepare("INSERT INTO bookings VALUES ('b3','g3','s1','2099-01-11','10:00','12:00','confirmed',5000,'hourly')").run();
  // g4: 商談中・未入金 → 対象外（本予約のみ）
  db.db.prepare("INSERT INTO booking_groups VALUES ('g4','B004','D','web','c1','bank_transfer','unpaid')").run();
  db.db.prepare("INSERT INTO bookings VALUES ('b4','g4','s1','2099-01-12','10:00','12:00','tentative',5000,'hourly')").run();
  // g5: キャンセル・未入金 → 対象外
  db.db.prepare("INSERT INTO booking_groups VALUES ('g5','B005','E','web','c1','bank_transfer','unpaid')").run();
  db.db.prepare("INSERT INTO bookings VALUES ('b5','g5','s1','2099-01-13','10:00','12:00','cancelled',5000,'hourly')").run();
  return db;
}

d('予約一覧の未入金フィルタ（listBookingsForAdmin）', () => {
  it("payment='unpaid' は本予約かつ未入金のみを返す（過去日も含む・入金済み/商談中/キャンセルは除外）", async () => {
    const db = makeDb() as any;
    const rows = await listBookingsForAdmin(db, { payment: 'unpaid', todayYmd: '2026-09-01' });
    const nums = rows.map((r: any) => r.booking_number).sort();
    expect(nums).toEqual(['B001', 'B002']);
  });

  it('通常のアクティブ表示（未来の本予約のみ）とは結果が異なる', async () => {
    const db = makeDb() as any;
    const active = await listBookingsForAdmin(db, { view: 'active', todayYmd: '2026-09-01' });
    const nums = active.map((r: any) => r.booking_number).sort();
    // アクティブ：未来日でキャンセル以外（confirmed B001/B003＋tentative B004）。
    // 過去の未入金 B002 は出ない ＝ 未入金タブでしか拾えない。
    expect(nums).toEqual(['B001', 'B003', 'B004']);
    expect(nums).not.toContain('B002');
  });

  it('追加請求の入金状況（addl_pending/addl_paid）を集計して返す', async () => {
    const db = makeDb() as any;
    // g1 に未入金の追加請求、g3 に入金済みの追加請求（＋通常決済は集計対象外）を投入
    db.db.prepare("INSERT INTO booking_payments VALUES ('p1','g1','additional','pending')").run();
    db.db.prepare("INSERT INTO booking_payments VALUES ('p2','g3','additional','paid')").run();
    db.db.prepare("INSERT INTO booking_payments VALUES ('p3','g3','booking','paid')").run();
    const rows = await listBookingsForAdmin(db, { view: 'active', todayYmd: '2026-09-01' });
    const byNum: Record<string, any> = {};
    for (const r of rows) byNum[r.booking_number] = r;
    expect(Number(byNum['B001'].addl_pending)).toBe(1);
    expect(Number(byNum['B001'].addl_paid)).toBe(0);
    expect(Number(byNum['B003'].addl_pending)).toBe(0);
    expect(Number(byNum['B003'].addl_paid)).toBe(1); // 通常決済(kind='booking')は数えない
    expect(Number(byNum['B004'].addl_pending)).toBe(0);
    expect(Number(byNum['B004'].addl_paid)).toBe(0);
  });
});
