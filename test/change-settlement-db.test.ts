// @ts-nocheck 精算待ち（change_settlements）の CRUD とクーポン返却（buildCouponRestoreStmts）を検証。
// Phase B（申込＝即時反映／お金は管理者承認）のDB層。node:sqlite の in-memory で回す。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

let DatabaseSync: any;
let sqliteOk = true;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { sqliteOk = false; }
const d = sqliteOk ? describe : describe.skip;

class Stmt {
  private params: unknown[] = [];
  constructor(private db: any, private sql: string) {}
  bind(...args: unknown[]) { this.params = args.map((a) => (a === undefined ? null : a)); return this; }
  async first<T = unknown>() { return (this.db.prepare(this.sql).get(...(this.params as never[])) as T) ?? null; }
  async all<T = unknown>() { return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[] }; }
  async run() { return { meta: this.db.prepare(this.sql).run(...(this.params as never[])) }; }
}
class D1 {
  db = new DatabaseSync(':memory:');
  prepare(sql: string) { return new Stmt(this.db, sql); }
  async batch(stmts: Stmt[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

const {
  createChangeSettlement,
  listChangeSettlements,
  getChangeSettlementById,
  approveChangeSettlement,
  dismissChangeSettlement,
  buildCouponRestoreStmts,
} = await import('../src/db/repository');

function makeDb() {
  const db = new D1();
  db.db.exec(`
    CREATE TABLE change_settlements (
      id TEXT PRIMARY KEY, group_id TEXT, booking_number TEXT, customer_id TEXT, space_id TEXT,
      type TEXT, kind TEXT, direction TEXT, quoted_amount INTEGER, final_amount INTEGER,
      payment_method TEXT, old_items TEXT, new_items TEXT, note TEXT, status TEXT,
      created_at TEXT, resolved_at TEXT, resolved_by TEXT
    );
    CREATE TABLE booking_groups (id TEXT PRIMARY KEY, event_name TEXT, status TEXT);
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE customers (id TEXT PRIMARY KEY, contact_name TEXT, email TEXT, phone TEXT);
    CREATE TABLE discount_coupons (id TEXT PRIMARY KEY, remaining_hours REAL, status TEXT);
    CREATE TABLE coupon_usage (id TEXT PRIMARY KEY, coupon_id TEXT, booking_id TEXT, hours_consumed REAL);
    CREATE TABLE bookings (id TEXT PRIMARY KEY, group_id TEXT);
  `);
  db.db.prepare("INSERT INTO booking_groups VALUES ('g1','会議','cancelled')").run();
  db.db.prepare("INSERT INTO spaces VALUES ('s1','名駅フリー')").run();
  db.db.prepare("INSERT INTO customers VALUES ('c1','山田太郎','y@example.com','090')").run();
  return db;
}

d('精算待ち CRUD（change_settlements）', () => {
  it('作成→一覧→取得（JOINで表示情報が付く）', async () => {
    const db = makeDb() as any;
    const id = await createChangeSettlement(db, {
      groupId: 'g1', bookingNumber: 'ALBE-1', customerId: 'c1', spaceId: 's1',
      type: 'cancel', kind: 'cancel', direction: 'refund', quotedAmount: 5000,
      paymentMethod: 'stripe', oldItems: [{ date: '2026-10-01', startTime: '10:00', endTime: '12:00' }], newItems: null, note: 'テスト',
    }, '2026-09-06 10:00:00');
    expect(id).toBeTruthy();

    const list = await listChangeSettlements(db, 'pending');
    expect(list.length).toBe(1);
    expect(list[0].space_name).toBe('名駅フリー');
    expect(list[0].event_name).toBe('会議');
    expect(list[0].customer_email).toBe('y@example.com');
    expect(list[0].quoted_amount).toBe(5000);
    expect(list[0].status).toBe('pending');

    const got = await getChangeSettlementById(db, id);
    expect(got.direction).toBe('refund');
    expect(got.old_items).toContain('2026-10-01');
  });

  it('承認：final_amount と resolved_* を記録、pending 以外へは変わらない', async () => {
    const db = makeDb() as any;
    const id = await createChangeSettlement(db, {
      groupId: 'g1', bookingNumber: 'ALBE-1', customerId: 'c1', spaceId: 's1',
      type: 'reschedule', kind: 'increase', direction: 'charge', quotedAmount: 3000,
      paymentMethod: 'stripe', oldItems: null, newItems: null, note: null,
    }, '2026-09-06 10:00:00');
    await approveChangeSettlement(db, id, { finalAmount: 2500, resolvedBy: 'admin@albe', now: '2026-09-06 11:00:00' });
    const got = await getChangeSettlementById(db, id);
    expect(got.status).toBe('approved');
    expect(got.final_amount).toBe(2500);
    expect(got.resolved_by).toBe('admin@albe');
    // 二重承認は効かない（status guard）
    await approveChangeSettlement(db, id, { finalAmount: 9999, resolvedBy: 'x', now: 'n' });
    const again = await getChangeSettlementById(db, id);
    expect(again.final_amount).toBe(2500);
  });

  it('差し戻し：dismissed とメモ追記', async () => {
    const db = makeDb() as any;
    const id = await createChangeSettlement(db, {
      groupId: 'g1', bookingNumber: 'ALBE-1', customerId: 'c1', spaceId: 's1',
      type: 'cancel', kind: 'cancel', direction: 'none', quotedAmount: 0,
      paymentMethod: 'ticket', oldItems: null, newItems: null, note: '元メモ',
    }, '2026-09-06 10:00:00');
    await dismissChangeSettlement(db, id, { note: '要電話連絡', resolvedBy: 'admin@albe', now: '2026-09-06 12:00:00' });
    const got = await getChangeSettlementById(db, id);
    expect(got.status).toBe('dismissed');
    expect(got.note).toContain('元メモ');
    expect(got.note).toContain('要電話連絡');
  });
});

d('クーポン返却（buildCouponRestoreStmts）', () => {
  function seedCoupon(db: any) {
    db.db.prepare("INSERT INTO discount_coupons VALUES ('cp1', 1, 'exhausted')").run();
    db.db.prepare("INSERT INTO bookings VALUES ('b1','g1')").run();
    db.db.prepare("INSERT INTO coupon_usage VALUES ('cu1','cp1','b1', 3)").run();
  }
  it('消費時間を残時間へ戻し、coupon_usage を解消（exhausted→active）', async () => {
    const db = makeDb() as any;
    seedCoupon(db);
    const plan = await buildCouponRestoreStmts(db, 'g1');
    expect(plan).not.toBeNull();
    expect(plan.couponId).toBe('cp1');
    expect(plan.hours).toBe(3);
    await db.batch(plan.stmts);
    const cp = db.db.prepare("SELECT remaining_hours, status FROM discount_coupons WHERE id='cp1'").get();
    expect(cp.remaining_hours).toBe(4); // 1 + 3
    expect(cp.status).toBe('active');
    const usage = db.db.prepare("SELECT COUNT(*) AS c FROM coupon_usage WHERE booking_id='b1'").get();
    expect(usage.c).toBe(0);
  });
  it('クーポン利用が無ければ null', async () => {
    const db = makeDb() as any;
    db.db.prepare("INSERT INTO bookings VALUES ('b1','g1')").run();
    const plan = await buildCouponRestoreStmts(db, 'g1');
    expect(plan).toBeNull();
  });
});
