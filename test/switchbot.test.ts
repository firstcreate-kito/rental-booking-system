import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { switchbotConfigured, unlockLock } from '../src/lib/switchbot';
import { performUnlock, runSwitchbotAutoUnlock } from '../src/lib/switchbot-service';

// --- 最小のD1モック（このテストが触るクエリだけを解釈する） ---
type Space = { id: string; switchbot_unlock_mode: string; switchbot_lock_device_id: string | null; switchbot_unlock_lead_min: number; sort_order: number };
type Cand = { groupId: string; bookingNumber: string; spaceId: string; date: string; startTime: string; endTime: string };
interface LogRow { booking_group_id: string | null; slot_key: string | null; trigger: string; status: string; device_id: string | null }

function makeDb(spaces: Space[], candidates: Cand[]) {
  const log: LogRow[] = [];
  const db = {
    _log: log,
    prepare(sql: string) {
      const s = sql.replace(/\s+/g, ' ').trim();
      let bound: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { bound = args; return api; },
        async all<T>() {
          if (s.startsWith('SELECT * FROM spaces')) return { results: spaces as unknown as T[] };
          if (s.includes('FROM bookings b JOIN booking_groups')) return { results: candidates as unknown as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (s.includes('FROM switchbot_unlock_log') && s.includes("trigger = 'auto'")) {
            const [gid, slot] = bound as [string, string];
            const hit = log.find((r) => r.booking_group_id === gid && r.slot_key === slot && r.trigger === 'auto' && r.status === 'success');
            return (hit ? { x: 1 } : null) as T | null;
          }
          return null as T | null;
        },
        async run() {
          if (s.startsWith('INSERT INTO switchbot_unlock_log')) {
            // 列順: id, created_at, space_id, booking_group_id, booking_number, slot_key, device_id, trigger, status, detail
            const [, , , gid, , slot, dev, trig, status] = bound as string[];
            log.push({ booking_group_id: gid ?? null, slot_key: slot ?? null, trigger: trig, status, device_id: dev ?? null });
          }
          return { success: true };
        },
      };
      return api;
    },
  };
  return db as unknown as D1Database & { _log: LogRow[] };
}

const CONFIGURED = { SWITCHBOT_TOKEN: 't', SWITCHBOT_SECRET: 's' };

describe('switchbotConfigured', () => {
  it('両方揃えば true・片方でも欠ければ false', () => {
    expect(switchbotConfigured(CONFIGURED)).toBe(true);
    expect(switchbotConfigured({ SWITCHBOT_TOKEN: 't' })).toBe(false);
    expect(switchbotConfigured({ SWITCHBOT_SECRET: 's' })).toBe(false);
    expect(switchbotConfigured({})).toBe(false);
  });
});

describe('unlockLock（解錠コマンドのみ送る＝A案）', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  it('command=unlock を POST し、施錠系コマンドは送らない', async () => {
    const seen: { url: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ statusCode: 100, message: 'success', body: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await unlockLock(CONFIGURED, 'DEV1');
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain('/v1.1/devices/DEV1/commands');
    expect((seen[0].body as { command: string }).command).toBe('unlock');
    // 施錠(lock)は絶対に送らない
    expect(JSON.stringify(seen[0].body)).not.toContain('"lock"');
  });
});

describe('performUnlock', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  it('未設定なら失敗を返しAPIを叩かない', async () => {
    const db = makeDb([], []);
    const r = await performUnlock({ DB: db } as never, { id: 'sp', switchbot_lock_device_id: 'D' }, { trigger: 'admin_test' });
    expect(r.ok).toBe(false);
  });
  it('deviceId未設定なら失敗を返す', async () => {
    const db = makeDb([], []);
    const r = await performUnlock({ ...CONFIGURED, DB: db } as never, { id: 'sp', switchbot_lock_device_id: null }, { trigger: 'admin_test' });
    expect(r.ok).toBe(false);
  });
  it('成功時はログにsuccessを残す', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ statusCode: 100 }), { status: 200 })) as unknown as typeof fetch;
    const db = makeDb([], []);
    const r = await performUnlock({ ...CONFIGURED, DB: db } as never, { id: 'sp', switchbot_lock_device_id: 'D' }, { trigger: 'admin_test' });
    expect(r.ok).toBe(true);
    expect(db._log).toHaveLength(1);
    expect(db._log[0].status).toBe('success');
  });
});

describe('runSwitchbotAutoUnlock（自動解錠の時刻窓と重複防止）', () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    globalThis.fetch = vi.fn(async () => { calls++; return new Response(JSON.stringify({ statusCode: 100 }), { status: 200 }); }) as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  const space = (over: Partial<Space> = {}): Space => ({ id: 'meieki-free', switchbot_unlock_mode: 'auto', switchbot_lock_device_id: 'LOCK1', switchbot_unlock_lead_min: 5, sort_order: 0, ...over });
  const cand: Cand = { groupId: 'g1', bookingNumber: 'B1', spaceId: 'meieki-free', date: '2026-09-10', startTime: '10:00', endTime: '12:00' };

  it('未設定なら何もしない', async () => {
    const db = makeDb([space()], [cand]);
    const r = await runSwitchbotAutoUnlock({ DB: db } as never, '2026-09-10 09:57');
    expect(r.unlocked).toBe(0);
    expect(calls).toBe(0);
  });

  it('開始5分前(lead)ちょうどで解錠する', async () => {
    const db = makeDb([space()], [cand]);
    const r = await runSwitchbotAutoUnlock({ ...CONFIGURED, DB: db } as never, '2026-09-10 09:55');
    expect(r.unlocked).toBe(1);
    expect(calls).toBe(1);
  });

  it('lead分より前（窓の外）では解錠しない', async () => {
    const db = makeDb([space()], [cand]);
    const r = await runSwitchbotAutoUnlock({ ...CONFIGURED, DB: db } as never, '2026-09-10 09:40');
    expect(r.unlocked).toBe(0);
    expect(calls).toBe(0);
  });

  it('開始+30分を過ぎたら解錠しない', async () => {
    const db = makeDb([space()], [cand]);
    const r = await runSwitchbotAutoUnlock({ ...CONFIGURED, DB: db } as never, '2026-09-10 10:31');
    expect(r.unlocked).toBe(0);
  });

  it('同じコマは二度解錠しない（重複防止）', async () => {
    const db = makeDb([space()], [cand]);
    const r1 = await runSwitchbotAutoUnlock({ ...CONFIGURED, DB: db } as never, '2026-09-10 09:55');
    const r2 = await runSwitchbotAutoUnlock({ ...CONFIGURED, DB: db } as never, '2026-09-10 10:00');
    expect(r1.unlocked).toBe(1);
    expect(r2.unlocked).toBe(0);
    expect(calls).toBe(1);
  });

  it('mode=off/button のスペースは自動解錠しない', async () => {
    const dbOff = makeDb([space({ switchbot_unlock_mode: 'off' })], [cand]);
    const dbBtn = makeDb([space({ switchbot_unlock_mode: 'button' })], [cand]);
    expect((await runSwitchbotAutoUnlock({ ...CONFIGURED, DB: dbOff } as never, '2026-09-10 09:55')).unlocked).toBe(0);
    expect((await runSwitchbotAutoUnlock({ ...CONFIGURED, DB: dbBtn } as never, '2026-09-10 09:55')).unlocked).toBe(0);
  });

  it('deviceId未設定のautoスペースはスキップ', async () => {
    const db = makeDb([space({ switchbot_lock_device_id: null })], [cand]);
    const r = await runSwitchbotAutoUnlock({ ...CONFIGURED, DB: db } as never, '2026-09-10 09:55');
    expect(r.unlocked).toBe(0);
    expect(calls).toBe(0);
  });
});
