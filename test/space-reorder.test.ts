// @ts-nocheck 実SQLエンジン（node:sqlite）で表示順の一括更新（#103）を検証。
// reorderSpaces で並び替えた順に sort_order が 0,1,2... となり、
// getActiveSpaces（ORDER BY sort_order）がその順で返すことを確認する。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

let DatabaseSync: any;
let sqliteOk = true;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { sqliteOk = false; }
const d = sqliteOk ? describe : describe.skip;

const { reorderSpaces, getActiveSpaces } = await import('../src/db/repository');

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
  async batch(stmts: Stmt[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

function makeDb() {
  const db = new D1();
  db.db.exec('CREATE TABLE spaces (id TEXT PRIMARY KEY, is_active INTEGER, sort_order INTEGER);');
  // 初期はすべて sort_order=0（＝順序未指定）
  for (const id of ['a', 'b', 'c', 'd']) {
    db.db.prepare('INSERT INTO spaces (id,is_active,sort_order) VALUES (?,1,0)').run(id);
  }
  return db;
}

d('スペース表示順の一括更新（#103）', () => {
  it('reorderSpaces で渡した順に sort_order=0,1,2... が振られ、getActiveSpaces がその順で返す', async () => {
    const db = makeDb() as any;
    await reorderSpaces(db, ['c', 'a', 'd', 'b']);
    const rows = await getActiveSpaces(db);
    expect(rows.map((r: any) => r.id)).toEqual(['c', 'a', 'd', 'b']);
    expect(rows.map((r: any) => r.sort_order)).toEqual([0, 1, 2, 3]);
  });

  it('別の順に再度並べ替えても上書きされる（冪等・再入可能）', async () => {
    const db = makeDb() as any;
    await reorderSpaces(db, ['c', 'a', 'd', 'b']);
    await reorderSpaces(db, ['d', 'c', 'b', 'a']);
    const rows = await getActiveSpaces(db);
    expect(rows.map((r: any) => r.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('空配列は何もしない（no-op）', async () => {
    const db = makeDb() as any;
    await reorderSpaces(db, []);
    const rows = await getActiveSpaces(db);
    // 全て sort_order=0 のまま。id 昇順（挿入順）で安定して返る。
    expect(rows.map((r: any) => r.sort_order)).toEqual([0, 0, 0, 0]);
  });
});
