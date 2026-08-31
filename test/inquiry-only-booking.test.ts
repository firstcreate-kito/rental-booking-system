// @ts-nocheck 実SQLエンジン（node:sqlite）で本番の bookings ルートをそのまま動かすガード検証。
// 申込はお問い合わせのみ（inquiry_only）の施設は、サーバー側で予約作成を必ず拒否する。
// フロントのクリック差し替えを通り抜ける経路（別ページ・再予約・直接API）対策の回帰テスト。
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

let DatabaseSync: any;
let sqliteOk = true;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { sqliteOk = false; }
const d = sqliteOk ? describe : describe.skip;

const bookings = (await import('../src/routes/bookings')).default;

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

function makeEnv(inquiryOnly: number) {
  const db = new D1();
  // getSpaceById は SELECT * を行うため、必要列を一通り用意（値は最小限）。
  db.db.exec(`CREATE TABLE spaces (
    id TEXT PRIMARY KEY, name TEXT, is_active INTEGER, inquiry_only INTEGER,
    allow_card INTEGER, allow_paypal INTEGER, allow_invoice INTEGER, allow_manual_invoice INTEGER
  );`);
  db.db.prepare(`INSERT INTO spaces (id,name,is_active,inquiry_only,allow_card,allow_paypal,allow_invoice,allow_manual_invoice)
    VALUES ('sakae-chapel','栄チャペルスペース',1,?,1,1,1,0)`).run(inquiryOnly);
  return { DB: db } as any;
}

const validBody = {
  spaceId: 'sakae-chapel',
  eventName: 'テスト',
  customer: { contactName: '山田 太郎', email: 'y@example.com', phone: '090-1234-5678' },
  items: [{ date: '2026-12-01', startTime: '10:00', endTime: '12:00' }],
  paymentMethod: 'stripe',
  purpose: '会議・ミーティング',
  headcount: 2,
  termsAgreed: true,
};

d('inquiry_only 施設のネット予約はサーバー側で拒否', () => {
  it('inquiry_only=1 の施設は 403 INQUIRY_ONLY で拒否される', async () => {
    const res = await bookings.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    }, makeEnv(1));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('INQUIRY_ONLY');
  });

  it('inquiry_only=0 の施設はこのガードを通過する（INQUIRY_ONLY では止まらない）', async () => {
    const res = await bookings.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    }, makeEnv(0));
    // ガード以降のDB（会員/ブラックリスト等）が無いため処理は先で失敗するが、
    // 少なくとも INQUIRY_ONLY の 403 では止まらないことを確認する。
    if (res.status === 403) {
      const body = await res.json();
      expect(body.code).not.toBe('INQUIRY_ONLY');
    } else {
      expect(res.status).not.toBe(403);
    }
  });
});
