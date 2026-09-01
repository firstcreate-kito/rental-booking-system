// @ts-nocheck 管理者通知の宛先解決（adminRecipients）を検証。
// 本部（rental@space-albe.com）は常に含め、MAIL_ADMIN 未設定でも宛先ゼロ（無送信）に
// ならないこと、スペース別 notify_email が併記されること、重複が排除されることを確認する。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

let DatabaseSync: any;
let sqliteOk = true;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { sqliteOk = false; }
const d = sqliteOk ? describe : describe.skip;

const { adminRecipients } = await import('../src/lib/notify');

class Stmt {
  private params: unknown[] = [];
  constructor(private db: any, private sql: string) {}
  bind(...args: unknown[]) { this.params = args; return this; }
  async first<T = unknown>() { return (this.db.prepare(this.sql).get(...(this.params as never[])) as T) ?? null; }
}
class D1 {
  db = new DatabaseSync(':memory:');
  prepare(sql: string) { return new Stmt(this.db, sql); }
}

function makeDb() {
  const db = new D1();
  db.db.exec('CREATE TABLE spaces (id TEXT PRIMARY KEY, notify_email TEXT);');
  db.db.prepare("INSERT INTO spaces (id, notify_email) VALUES ('with-notify', 'owner@x.com')").run();
  db.db.prepare("INSERT INTO spaces (id, notify_email) VALUES ('no-notify', NULL)").run();
  return db;
}

d('管理者通知の宛先解決（adminRecipients）', () => {
  it('MAIL_ADMIN 未設定でも本部（rental@space-albe.com）に必ず届く', async () => {
    const env = { DB: makeDb() } as any;
    const to = await adminRecipients(env, 'no-notify');
    expect(to).toEqual(['rental@space-albe.com']);
  });

  it('MAIL_ADMIN が本部と同一なら重複しない', async () => {
    const env = { DB: makeDb(), MAIL_ADMIN: 'rental@space-albe.com' } as any;
    const to = await adminRecipients(env, 'no-notify');
    expect(to).toEqual(['rental@space-albe.com']);
  });

  it('MAIL_ADMIN が別アドレスなら本部と両方に届く', async () => {
    const env = { DB: makeDb(), MAIL_ADMIN: 'ops@x.com' } as any;
    const to = await adminRecipients(env, 'no-notify');
    expect(to).toContain('rental@space-albe.com');
    expect(to).toContain('ops@x.com');
  });

  it('スペース別 notify_email も併記される（本部＋スペース）', async () => {
    const env = { DB: makeDb() } as any;
    const to = await adminRecipients(env, 'with-notify');
    expect(to).toContain('rental@space-albe.com');
    expect(to).toContain('owner@x.com');
  });

  it('spaceId 未指定でも本部には届く', async () => {
    const env = { DB: makeDb() } as any;
    const to = await adminRecipients(env, null);
    expect(to).toEqual(['rental@space-albe.com']);
  });
});
