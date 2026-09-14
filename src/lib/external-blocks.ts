/**
 * 外部予約（スペースマーケット/インスタベース等・Googleカレンダー連携のみ）を
 * D1の external_calendar_blocks へ「占有ブロック」として取り込む同期ジョブ（5分毎Cron）。
 *
 * 目的：公式サイトの空き状況（/availability = D1のみ参照）にも外部予約を反映し、
 *       毎回のGoogle照会なしで正確・高速に空きを出す。
 * 方針：本体 bookings は汚さない（別テーブル）。自社予約由来の予定は google_event_id で除外。
 *       差分upsert＋不要行削除でGカレンダーと突き合わせる（書き込みは変化分のみ＝低負荷）。
 */
import type { Env } from '../types';
import {
  getActiveSpaces,
  getBookingGoogleEventIdsInRange,
  getExternalBlocksForSpace,
  upsertExternalBlocks,
  deleteExternalBlocks,
  type ExternalBlockRow,
} from '../db/repository';
import { gcalConfigured, listEvents, toJstRfc3339, rfc3339ToJst } from './gcal';
import { todayJST, addDaysJST } from './clock';

// 取り込み対象の前方期間（日）。閲覧可能期間（最大180日程度）をカバーする。
const HORIZON_DAYS = 180;

/** Googleカレンダーの外部予定を日別ブロックに展開して external_calendar_blocks を同期する。 */
export async function syncExternalCalendarBlocks(
  env: Env,
): Promise<{ spaces: number; upserted: number; deleted: number }> {
  const out = { spaces: 0, upserted: 0, deleted: 0 };
  if (!gcalConfigured(env)) return out;
  const today = todayJST();
  const to = addDaysJST(today, HORIZON_DAYS);
  const startISO = toJstRfc3339(today, '00:00');
  const endISO = toJstRfc3339(addDaysJST(to, 1), '00:00');

  const spaces = await getActiveSpaces(env.DB);
  for (const s of spaces) {
    const calendarId = s.google_calendar_id;
    if (!calendarId) continue;
    let events;
    try {
      events = await listEvents(env, calendarId, startISO, endISO, 2500);
    } catch {
      continue; // 1施設の照会失敗で全体を止めない。次回Cronで再試行。
    }
    const nativeIds = new Set(await getBookingGoogleEventIdsInRange(env.DB, s.id, today, to));

    // 現在のカレンダーから、外部予約（自社予約以外）を日別ブロックに展開する。
    const current: ExternalBlockRow[] = [];
    for (const e of events) {
      if (!e.id || nativeIds.has(e.id)) continue; // 自社予約は bookings 側で反映済み
      const st = rfc3339ToJst(e.start);
      const en = rfc3339ToJst(e.end);
      // st.date〜en.date の各日を「当日ぶん」にクランプしてブロック化（複数日イベント対応）。
      let d = st.date < today ? today : st.date;
      for (let guard = 0; d <= en.date && d <= to && guard < 400; guard++, d = addDaysJST(d, 1)) {
        const startTime = d === st.date ? st.time : '00:00';
        const endTime = d === en.date ? en.time : '24:00';
        // 予定がその日の 00:00 ちょうどで終わる場合、その日はブロック不要（前日24:00で完結）。
        if (d === en.date && en.time === '00:00' && d !== st.date) break;
        if (startTime >= endTime) continue;
        current.push({
          id: `${e.id}#${d}`,
          google_event_id: e.id,
          space_id: s.id,
          date: d,
          start_time: startTime,
          end_time: endTime,
          summary: e.summary ?? null,
        });
      }
    }

    // 差分適用：既存と突き合わせ、新規・変更ぶんのみ upsert、消えたぶんは削除（書き込み最小化）。
    const existing = await getExternalBlocksForSpace(env.DB, s.id, today, to);
    const existingMap = new Map(existing.map((r) => [r.id, r]));
    const currentIds = new Set(current.map((b) => b.id));
    const changed = current.filter((b) => {
      const prev = existingMap.get(b.id);
      return !prev || prev.start_time !== b.start_time || prev.end_time !== b.end_time;
    });
    const stale = existing.map((r) => r.id).filter((id) => !currentIds.has(id));

    if (changed.length) await upsertExternalBlocks(env.DB, changed);
    if (stale.length) await deleteExternalBlocks(env.DB, stale);
    out.spaces++;
    out.upserted += changed.length;
    out.deleted += stale.length;
  }
  console.log(`[extblocks] sync spaces=${out.spaces} upserted=${out.upserted} deleted=${out.deleted}`);
  return out;
}
