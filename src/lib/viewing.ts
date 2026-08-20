/**
 * 見学申込のロジック（純粋関数）。
 * - 所要30分固定。
 * - 空き＝営業時間内かつ「本予約(confirmed)・商談中(tentative)・ブロック・仮確保のいずれも入っていない」枠。
 *   （computeFreeWindows の OCCUPYING_STATUSES と同一基準）
 * - 複数施設は「選んだ全施設が同じ枠で空いている」共通枠のみを候補にする。
 */
import { computeFreeWindows } from './availability';

export const VIEWING_DURATION_MIN = 30;
/** 開始時刻を並べる刻み（分）。30分刻み。 */
export const VIEWING_GRID_MIN = 30;
/** 見学申込で先の日付を受け付ける上限（当日から）。予約可能期間とは別枠。 */
export const VIEWING_MAX_AHEAD_DAYS = 180;

function toMin(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}
function toHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 空き時間帯の集合から、見学(duration分)を置ける開始時刻の集合を返す（gridMin刻み）。 */
export function startTimesFromWindows(
  windows: ReadonlyArray<{ start: string; end: string }>,
  durationMin: number = VIEWING_DURATION_MIN,
  gridMin: number = VIEWING_GRID_MIN,
): string[] {
  const out = new Set<string>();
  for (const w of windows) {
    const ws = toMin(w.start);
    const we = toMin(w.end);
    // grid に合わせて開始位置を切り上げる
    let t = Math.ceil(ws / gridMin) * gridMin;
    for (; t + durationMin <= we; t += gridMin) {
      out.add(toHHMM(t));
    }
  }
  return [...out].sort();
}

export interface SpaceDayInput {
  /** 占有予約（status付き）。computeFreeWindows がフィルタする。 */
  occupying: ReadonlyArray<{ startTime: string; endTime: string; status: string }>;
  openTime: string;
  closeTime: string;
  /** 休業日なら true（＝候補なし） */
  closed?: boolean;
}

/**
 * 複数施設の「共通で見学できる開始時刻」を返す。
 * どれか1施設でも休業/空きなしなら、その施設が制約となり結果は空になる。
 */
export function commonViewingStartTimes(
  spaces: ReadonlyArray<SpaceDayInput>,
  durationMin: number = VIEWING_DURATION_MIN,
  gridMin: number = VIEWING_GRID_MIN,
): string[] {
  if (spaces.length === 0) return [];
  let common: string[] | null = null;
  for (const s of spaces) {
    if (s.closed) return [];
    const windows = computeFreeWindows(s.occupying, s.openTime, s.closeTime, gridMin);
    const set = new Set(startTimesFromWindows(windows, durationMin, gridMin));
    if (common === null) {
      common = [...set];
    } else {
      // 積集合
      common = common.filter((t) => set.has(t));
    }
    if (common.length === 0) return [];
  }
  return (common ?? []).slice().sort();
}

/** 1施設の見学可能な開始時刻（単一施設ケースの簡便関数） */
export function viewingStartTimesForSpace(input: SpaceDayInput): string[] {
  return commonViewingStartTimes([input]);
}

/** 現在の予約状況ラベル */
export function bookingStatusLabel(v: string): string {
  return { booked: '予約済み', considering: '予約検討中', other: 'その他' }[v] ?? v;
}
