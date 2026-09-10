/**
 * SwitchBotロック解錠のオーケストレーション（#123・A案＝解錠のみ／施錠しない）。
 * - auto  … 利用開始時刻（lead分前〜開始+30分）に自動解錠（5分毎Cron）。
 * - button… お客様/管理者が任意に解錠（performUnlock を直接呼ぶ）。
 * どの方式でも施錠コマンドは送らない。
 */
import type { Env } from '../types';
import { getAllSpaces, getAutoUnlockCandidates, hasAutoUnlocked, insertUnlockLog, type SpaceRow } from '../db/repository';
import { switchbotConfigured, unlockLock } from './switchbot';
import { nowJST } from './clock';

function toMin(hhmm: string): number {
  const [h, m] = String(hhmm).split(':');
  return Number(h) * 60 + (Number(m) || 0);
}

/** 1スペースのロックを解錠してログを残す（管理者テスト・解錠ボタン共通）。 */
export async function performUnlock(
  env: Env,
  space: Pick<SpaceRow, 'id' | 'switchbot_lock_device_id'>,
  meta: { trigger: string; groupId?: string | null; bookingNumber?: string | null; slotKey?: string | null },
  now: string = nowJST(),
): Promise<{ ok: boolean; message: string }> {
  if (!switchbotConfigured(env)) return { ok: false, message: 'SwitchBotが未設定です（トークン/シークレット未投入）' };
  const deviceId = space.switchbot_lock_device_id;
  if (!deviceId) return { ok: false, message: 'このスペースにSwitchBotロックのdeviceIdが設定されていません' };
  const r = await unlockLock(env, deviceId);
  await insertUnlockLog(
    env.DB,
    {
      spaceId: space.id,
      groupId: meta.groupId ?? null,
      bookingNumber: meta.bookingNumber ?? null,
      slotKey: meta.slotKey ?? null,
      deviceId,
      trigger: meta.trigger,
      status: r.ok ? 'success' : 'failed',
      detail: r.ok ? null : `statusCode=${r.statusCode} http=${r.httpStatus} ${r.message ?? ''}`.trim(),
    },
    now,
  );
  return { ok: r.ok, message: r.ok ? '解錠しました' : `解錠に失敗しました（${r.message ?? 'statusCode=' + r.statusCode}）` };
}

/**
 * 自動解錠（mode=auto のスペース）。5分毎Cronから呼ぶ。
 * 各コマの「開始lead分前〜開始+30分」で、まだ自動解錠していなければ解錠する。
 */
export async function runSwitchbotAutoUnlock(env: Env, now: string = nowJST()): Promise<{ unlocked: number; skipped: number; failed: number }> {
  const out = { unlocked: 0, skipped: 0, failed: 0 };
  if (!switchbotConfigured(env)) return out;
  const today = now.slice(0, 10);
  const nowMin = toMin(now.slice(11, 16));
  const spaces = await getAllSpaces(env.DB);
  const autoSpaces = new Map<string, SpaceRow>();
  for (const s of spaces) {
    if (s.switchbot_unlock_mode === 'auto' && s.switchbot_lock_device_id) autoSpaces.set(s.id, s);
  }
  if (autoSpaces.size === 0) return out;

  const candidates = await getAutoUnlockCandidates(env.DB, today);
  for (const c of candidates) {
    const space = autoSpaces.get(c.spaceId);
    if (!space) continue;
    const startMin = toMin(c.startTime);
    const lead = space.switchbot_unlock_lead_min ?? 5;
    // 解錠ウィンドウ：開始 lead 分前 〜 開始+30分（取りこぼし救済）
    if (nowMin < startMin - lead || nowMin > startMin + 30) {
      out.skipped++;
      continue;
    }
    const slotKey = `${c.date} ${c.startTime}`;
    if (await hasAutoUnlocked(env.DB, c.groupId, slotKey)) {
      out.skipped++;
      continue;
    }
    const r = await performUnlock(env, space, { trigger: 'auto', groupId: c.groupId, bookingNumber: c.bookingNumber, slotKey }, now);
    if (r.ok) out.unlocked++;
    else out.failed++;
  }
  console.log(`[switchbot] auto-unlock unlocked=${out.unlocked} skipped=${out.skipped} failed=${out.failed}`);
  return out;
}
