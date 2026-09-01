// @ts-nocheck 施設カレンダー埋め込み（#19）のSSRルート検証。
// 施設の解決（slug/id）と、未知スペース・未指定・非公開の扱いを確認する。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { Hono } from 'hono';

let DatabaseSync: any;
let sqliteOk = true;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { sqliteOk = false; }
const d = sqliteOk ? describe : describe.skip;

const { embedCalendar } = await import('../src/routes/embed');

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

function makeEnv() {
  const db = new D1();
  db.db.exec('CREATE TABLE spaces (id TEXT PRIMARY KEY, slug TEXT, name TEXT, is_active INTEGER);');
  db.db.prepare("INSERT INTO spaces (id,slug,name,is_active) VALUES ('meieki-free','meiekifree','名駅フリースペース',1)").run();
  db.db.prepare("INSERT INTO spaces (id,slug,name,is_active) VALUES ('hidden-space',NULL,'非公開スペース',0)").run();
  return { DB: db } as any;
}

function app() {
  const a = new Hono();
  a.get('/embed/calendar', embedCalendar);
  return a;
}

d('施設カレンダー埋め込み（#19）', () => {
  it('id 指定で 200・施設名とカレンダー要素・APIパス（id）を含むHTMLを返す', async () => {
    const res = await app().request('/embed/calendar?space=meieki-free', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') || '').toContain('text/html');
    const html = await res.text();
    expect(html).toContain('名駅フリースペース');
    expect(html).toContain('id="grid"');
    // クライアントは解決済みの id で slots API を叩く
    expect(html).toContain("'/api/spaces/'");
    expect(html).toContain('meieki-free');
  });

  it('slug 指定でも同じ施設に解決される（id を CFG に渡す）', async () => {
    const res = await app().request('/embed/calendar?space=meiekifree', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('名駅フリースペース');
    expect(html).toContain('"id":"meieki-free"');
  });

  it('month 指定が CFG に反映される', async () => {
    const res = await app().request('/embed/calendar?space=meieki-free&month=2026-10', {}, makeEnv());
    const html = await res.text();
    expect(html).toContain('"month":"2026-10"');
  });

  it('space 未指定は 400', async () => {
    const res = await app().request('/embed/calendar', {}, makeEnv());
    expect(res.status).toBe(400);
  });

  it('未知スペースは 404', async () => {
    const res = await app().request('/embed/calendar?space=nope', {}, makeEnv());
    expect(res.status).toBe(404);
  });

  it('非公開（is_active=0）スペースは 404', async () => {
    const res = await app().request('/embed/calendar?space=hidden-space', {}, makeEnv());
    expect(res.status).toBe(404);
  });
});
