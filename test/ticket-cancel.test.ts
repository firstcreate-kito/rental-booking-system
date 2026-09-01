// @ts-nocheck チケット払い予約のキャンセル方針（buildTicketCancelPlan）を検証。
// 方針：チケット予約は現金キャンセル料¥0。利用日「前日以前」は消費時間を全額返還、
// 「当日」は失効（返還なし）。非チケット予約は null を返す（従来のキャンセル料計算）。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

let DatabaseSync: any;
let sqliteOk = true;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { sqliteOk = false; }
const d = sqliteOk ? describe : describe.skip;

const { buildTicketCancelPlan } = await import('../src/db/repository');

class Stmt {
  private params: unknown[] = [];
  constructor(private db: any, private sql: string) {}
  bind(...args: unknown[]) { this.params = args; return this; }
  async first<T = unknown>() { return (this.db.prepare(this.sql).get(...(this.params as never[])) as T) ?? null; }
  async run() { return { meta: this.db.prepare(this.sql).run(...(this.params as never[])) }; }
}
class D1 {
  db = new DatabaseSync(':memory:');
  prepare(sql: string) { return new Stmt(this.db, sql); }
  async batch(stmts: Stmt[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

function makeDb() {
  const db = new D1();
  db.db.exec(`CREATE TABLE tickets (id TEXT PRIMARY KEY, remaining_hours REAL, status TEXT);`);
  db.db.exec(`CREATE TABLE ticket_usage (id TEXT PRIMARY KEY, ticket_id TEXT, booking_id TEXT, hours_consumed REAL);`);
  db.db.exec(`CREATE TABLE bookings (id TEXT PRIMARY KEY, group_id TEXT);`);
  // t1: 残3時間。g1 の予約 b1 が 2時間消費している。
  db.db.prepare("INSERT INTO tickets VALUES ('t1', 3, 'active')").run();
  db.db.prepare("INSERT INTO bookings VALUES ('b1', 'g1')").run();
  db.db.prepare("INSERT INTO ticket_usage VALUES ('tu1', 't1', 'b1', 2)").run();
  // g2: チケット払いでない（ticket_usage なし）
  db.db.prepare("INSERT INTO bookings VALUES ('b2', 'g2')").run();
  return db;
}

d('チケット払い予約のキャンセル方針（buildTicketCancelPlan）', () => {
  it('前日以前（本日 < 利用日）は返還：消費時間をチケット残へ戻す', async () => {
    const db = makeDb() as any;
    const plan = await buildTicketCancelPlan(db, 'g1', '2026-09-10', '2026-09-01');
    expect(plan).not.toBeNull();
    expect(plan.action).toBe('restore');
    expect(plan.hours).toBe(2);
    expect(plan.ticketId).toBe('t1');
    // 返還文を実行 → ticket_usage 削除・残時間 3+2=5・active
    await db.batch(plan.restoreStmts);
    const t = db.db.prepare("SELECT remaining_hours, status FROM tickets WHERE id='t1'").get();
    expect(t.remaining_hours).toBe(5);
    expect(t.status).toBe('active');
    const usage = db.db.prepare("SELECT COUNT(*) AS c FROM ticket_usage WHERE id='tu1'").get();
    expect(usage.c).toBe(0);
  });

  it('当日（本日 = 利用日）は失効：時間は戻さない（restoreStmts なし）', async () => {
    const db = makeDb() as any;
    const plan = await buildTicketCancelPlan(db, 'g1', '2026-09-01', '2026-09-01');
    expect(plan.action).toBe('forfeit');
    expect(plan.hours).toBe(2);
    expect(plan.restoreStmts).toHaveLength(0);
    // 失効なので残時間は 3 のまま・ticket_usage も残る
    const t = db.db.prepare("SELECT remaining_hours FROM tickets WHERE id='t1'").get();
    expect(t.remaining_hours).toBe(3);
  });

  it('非チケット払いの予約は null（従来どおりのキャンセル料計算）', async () => {
    const db = makeDb() as any;
    const plan = await buildTicketCancelPlan(db, 'g2', '2026-09-10', '2026-09-01');
    expect(plan).toBeNull();
  });
});
