import type { AppBindings } from '../types';
import {
  getBookingGroupById,
  getBookingsByGroup,
  getSpaceById,
  getOccupyingIntervalsExcludingGroup,
  promoteBookingGroupToConfirmed,
} from '../db/repository';
import { intervalsOverlap } from './availability';
import { checkCalendarConflictExcluding, syncBookingCalendarEvents } from './gcal-sync';

type Env = AppBindings['Bindings'];

export type FinalizeResult = 'confirmed' | 'conflict' | 'already' | 'notfound';

/** グループの全枠が今も空いているか（D1 の confirmed/tentative と GCal を再確認）※読み取りのみ */
export async function isGroupSlotFree(env: Env, groupId: string): Promise<boolean> {
  const g = await getBookingGroupById(env.DB, groupId);
  if (!g) return false;
  const rows = await getBookingsByGroup(env.DB, groupId);
  const space = await getSpaceById(env.DB, g.space_id);
  for (const b of rows) {
    const existing = await getOccupyingIntervalsExcludingGroup(env.DB, g.space_id, b.date, groupId);
    if (existing.some((e) => intervalsOverlap(b.start_time, b.end_time, e.start_time, e.end_time))) return false;
  }
  const items = rows.map((b) => ({ date: b.date, startTime: b.start_time, endTime: b.end_time }));
  // このグループ自身のカレンダー予定は除外して判定する。銀行振込・コンビニ等で
  // 作成時に既に自分のイベントを書き込んでいる場合、それを「外部の競合」と誤検知して
  // 入金済みの予約を不成立＋自動返金にしてしまうのを防ぐ（#39/#42）。
  const ownEventIds = rows.map((b) => b.google_event_id);
  const calc = await checkCalendarConflictExcluding(env, space?.google_calendar_id ?? null, items, ownEventIds);
  return !calc.conflict;
}

/**
 * 決済先行フロー（#68）の確定処理。
 * pending の予約について、入金確定時に「枠がまだ空いているか」を再確認し、
 *  - 空いていれば confirmed に昇格＋Googleカレンダーへ書き込み（成立）
 *  - 埋まっていれば 'conflict' を返す（呼び出し側で返金＋不成立処理）
 * 既に confirmed 済みなら 'already'（冪等）。
 */
export async function finalizeImmediateBooking(env: Env, groupId: string, origin: string): Promise<FinalizeResult> {
  const g = await getBookingGroupById(env.DB, groupId);
  if (!g) return 'notfound';
  if (g.status === 'confirmed') return 'already';
  // pending（カード即時）と tentative（コンビニ払込票で仮押さえ済み）を確定対象とする。
  if (g.status !== 'pending' && g.status !== 'tentative') return 'notfound'; // failed / cancelled 等は対象外

  // ①② 自システム（D1）＋Googleカレンダーで空きを再確認
  if (!(await isGroupSlotFree(env, groupId))) return 'conflict';

  // ③ 原子的に昇格（他の同時確定と競合したら promoted=false）
  const p = await promoteBookingGroupToConfirmed(env.DB, groupId);
  if (!p.promoted) {
    if (p.conflict) return 'conflict';
    // 既に他プロセスが confirmed 済みかを確認
    const g2 = await getBookingGroupById(env.DB, groupId);
    return g2?.status === 'confirmed' ? 'already' : 'conflict';
  }

  // ④ 確定できたのでカレンダーへ書き込み（台帳へ反映）
  await syncBookingCalendarEvents(env, groupId, origin).catch(() => {});
  return 'confirmed';
}
