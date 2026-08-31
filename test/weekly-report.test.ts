// @ts-nocheck 実SQLエンジン（node:sqlite・実験的ビルトイン）を使うため、当ファイルのみ型チェック対象外。
// #111 週次「翌週の予約」まとめメールの検証。
//  - clock: 週の月曜算出・曜日ラベル
//  - resolveWeeklyRecipients: 宛先解決（weekly→notify フォールバック・重複除去）
//  - buildWeeklyReports: 期間内のみ集計・スペース別グルーピング・cancelled/blocked/範囲外の除外
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { mondayOfWeekJST, weekdayLabelJST } from '../src/lib/clock';
import { weeklyReportEmail } from '../src/lib/email';
import { resolveWeeklyRecipients, buildWeeklyReports } from '../src/lib/weekly-report';

let DatabaseSync: any;
let sqliteOk = true;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { sqliteOk = false; }
const d = sqliteOk ? describe : describe.skip;

describe('#111 clock/宛先/テンプレの純粋ロジック', () => {
  it('mondayOfWeekJST：週内どの曜日でも同じ月曜を返す', () => {
    // 2026-08-31(月)〜09-06(日) の週
    expect(mondayOfWeekJST('2026-08-31')).toBe('2026-08-31'); // 月
    expect(mondayOfWeekJST('2026-09-02')).toBe('2026-08-31'); // 水
    expect(mondayOfWeekJST('2026-09-06')).toBe('2026-08-31'); // 日
    expect(mondayOfWeekJST('2026-09-07')).toBe('2026-09-07'); // 翌週月
  });
  it('weekdayLabelJST：曜日ラベル', () => {
    expect(weekdayLabelJST('2026-08-31')).toBe('月');
    expect(weekdayLabelJST('2026-09-06')).toBe('日');
  });
  it('resolveWeeklyRecipients：weekly優先・空ならnotifyへフォールバック・重複除去', () => {
    expect(resolveWeeklyRecipients({ weekly_report_recipients: 'a@x.com, b@x.com , a@x.com', notify_email: 'n@x.com' }))
      .toEqual(['a@x.com', 'b@x.com']);
    expect(resolveWeeklyRecipients({ weekly_report_recipients: '', notify_email: 'n@x.com' }))
      .toEqual(['n@x.com']);
    expect(resolveWeeklyRecipients({ weekly_report_recipients: null, notify_email: null }))
      .toEqual([]);
  });
  it('weeklyReportEmail：件名に件数、0件でも本文生成', () => {
    const m0 = weeklyReportEmail({ spaceName: 'テスト室', weekStart: '2026-09-07', weekEnd: '2026-09-13', items: [] });
    expect(m0.subject).toContain('計0件');
    expect(m0.subject).toContain('翌週の予約');
    expect(m0.text).toContain('翌週のご予約はありません');
    const m1 = weeklyReportEmail({
      spaceName: 'テスト室', weekStart: '2026-08-31', weekEnd: '2026-09-06',
      items: [{ date: '2026-09-01', weekday: '火', startTime: '10:00', endTime: '12:00', statusLabel: '確定', bookingNumber: '20260901-001', title: '撮影', phone: '090', headcount: 3 }],
    });
    expect(m1.subject).toContain('計1件');
    expect(m1.text).toContain('20260901-001');
    expect(m1.text).toContain('確定');
  });
});

// ---- D1 互換シム（node:sqlite） ----
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

d('#111 buildWeeklyReports（実SQL）', () => {
  let env: any;
  beforeEach(() => {
    const db = new D1();
    db.db.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT, is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0,
        notify_email TEXT, weekly_report_recipients TEXT);
      CREATE TABLE customers (id TEXT PRIMARY KEY, contact_name TEXT, phone TEXT, email TEXT);
      CREATE TABLE booking_groups (id TEXT PRIMARY KEY, booking_number TEXT, customer_id TEXT, space_id TEXT,
        event_name TEXT, headcount INTEGER, status TEXT);
      CREATE TABLE bookings (id TEXT PRIMARY KEY, group_id TEXT, space_id TEXT, date TEXT, start_time TEXT, end_time TEXT, status TEXT);
    `);
    // スペースA（週次宛先あり）・B（notifyのみ）・C（宛先なし）
    db.db.prepare(`INSERT INTO spaces (id,name,is_active,sort_order,notify_email,weekly_report_recipients) VALUES
      ('A','A室',1,1,'na@x.com','wa@x.com,wb@x.com'),
      ('B','B室',1,2,'nb@x.com',NULL),
      ('C','C室',1,3,NULL,NULL)`).run();
    db.db.prepare(`INSERT INTO customers (id,contact_name,phone,email) VALUES ('c1','山田','090-1','y@x.com')`).run();
    // 基準日 today=2026-09-02（今週=8/31〜9/6）。送信対象は「翌週」9/07(月)〜9/13(日)。
    // A: 翌週2件（確定・商談中）＋今週1件（除外）＋翌週のcancelled1件（除外）
    // B: 翌週1件＋今週1件（除外）／ C: 今週のみ（翌週0件）
    db.db.prepare(`INSERT INTO booking_groups (id,booking_number,customer_id,space_id,event_name,headcount,status) VALUES
      ('gAnow','20260901-001','c1','A','今週撮影',3,'confirmed'),
      ('gAnx1','20260908-001','c1','A','翌週撮影',2,'confirmed'),
      ('gAnx2','20260910-001',NULL,'A','翌週商談',NULL,'tentative'),
      ('gAcxl','20260909-001','c1','A','翌週キャンセル',1,'cancelled'),
      ('gBnow','20260902-001','c1','B','今週会議',4,'confirmed'),
      ('gBnx','20260907-001','c1','B','翌週会議',5,'confirmed'),
      ('gCnow','20260904-001','c1','C','今週のみ',1,'confirmed')`).run();
    db.db.prepare(`INSERT INTO bookings (id,group_id,space_id,date,start_time,end_time,status) VALUES
      ('bAnow','gAnow','A','2026-09-01','10:00','12:00','confirmed'),
      ('bAnx1','gAnx1','A','2026-09-08','10:00','12:00','confirmed'),
      ('bAnx2','gAnx2','A','2026-09-10','14:00','16:00','tentative'),
      ('bAcxl','gAcxl','A','2026-09-09','10:00','12:00','cancelled'),
      ('bBnow','gBnow','B','2026-09-02','09:00','11:00','confirmed'),
      ('bBnx','gBnx','B','2026-09-07','09:00','11:00','confirmed'),
      ('bCnow','gCnow','C','2026-09-04','10:00','12:00','confirmed')`).run();
    env = { DB: db, PUBLIC_BASE_URL: 'https://booking.space-albe.com' };
  });

  it('翌週分をスペース別に集計し、今週・cancelled は除外する', async () => {
    const reports = await buildWeeklyReports(env, '2026-09-02'); // 今週の水曜 → 対象は翌週
    const byId = Object.fromEntries(reports.map((r) => [r.spaceId, r]));
    expect(reports.length).toBe(3); // active 3スペース

    // A: 翌週2件（今週分・cancelled は除外）
    expect(byId.A.count).toBe(2);
    expect(byId.A.recipients).toEqual(['wa@x.com', 'wb@x.com']); // weekly優先
    expect(byId.A.weekStart).toBe('2026-09-07');
    expect(byId.A.weekEnd).toBe('2026-09-13');

    // B: 翌週1件（今週分は除外）・notifyへフォールバック
    expect(byId.B.count).toBe(1);
    expect(byId.B.recipients).toEqual(['nb@x.com']);

    // C: 今週のみ→翌週0件・宛先なし
    expect(byId.C.count).toBe(0);
    expect(byId.C.recipients).toEqual([]);
  });
});
