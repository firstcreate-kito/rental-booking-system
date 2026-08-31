/**
 * 空き状況ページ（/availability/）のデータ組み立て（#74）。
 * D1のみ参照（Googleは直接叩かない）。全施設×指定日を1回で計算し、
 * JSON API と SSR ページの両方から使う。
 */
import type { AppBindings } from '../types';
import {
  getActiveSpaces,
  getOccupyingBookingsAllSpaces,
  getHolidays,
  getSystemSetting,
  type SpaceRow,
} from '../db/repository';
import { todayJST, nowJST, addDaysJST } from './clock';
import { getDayType, daysBetween } from './calendar';
import { computeFreeWindows, classifySpaceDay, type AvailabilityGroup } from './availability';

type Env = AppBindings['Bindings'];

const AREA_NAME: Record<string, string> = {
  meieki: '名古屋駅',
  sakae: '栄',
  naka: '中区',
  chikusa: '千種区',
  other: 'その他',
};

const NEXT_OPEN_SCAN_DAYS = 45; // 「次に空いているのは」の前方走査上限

export interface AvailabilityRow {
  id: string;
  name: string;
  area: string | null;
  areaName: string;
  useCategory: string[];
  meta: string;
  price: number | null;
  priceUnit: string;
  roomsTotal: number;
  roomsFree: number;
  status: AvailabilityGroup;
  closed: boolean;
  freeWindows: Array<{ start: string; end: string }>;
  nextOpen: string | null; // 'YYYY-MM-DD'
  bookingHref: string | null;
  spaceHref: string; // 施設カレンダーへのリンク（日付なし）。直接予約不可の行でもまずカレンダーへ誘導する用
  viewOnly: boolean; // 予約可能期間超・閲覧のみ（ネット予約対象外→お問い合わせ）（#77）
  imageUrl: string | null; // サムネイル画像URL（左端に表示・グループ行は代表部屋の画像）#74拡張
}

export interface AvailabilityResult {
  date: string;
  weekdayLabel: string;
  isToday: boolean;
  lastSyncAt: string | null;
  filters: { use: string; area: string };
  counts: { open: number; total: number };
  groups: { ok: AvailabilityRow[]; talk: AvailabilityRow[]; sameday: AvailabilityRow[]; full: AvailabilityRow[] };
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
function weekdayLabelOf(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  // UTC基準で曜日算出（曜日はタイムゾーンに依らず日付から一意）
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${m}月${d}日（${WEEKDAYS[wd]}）`;
}

/** 起点価格（時間単価の安い方）。無ければ null。 */
function basePrice(s: SpaceRow): number | null {
  const rates = [s.weekday_rate, s.weekend_rate].filter((r): r is number => typeof r === 'number' && r > 0);
  return rates.length ? Math.min(...rates) : null;
}

/** グループ表示名（末尾の（A）（B）等を除去） */
function groupDisplayName(name: string): string {
  return name.replace(/[（(][A-Za-z0-9]+[）)]\s*$/, '').trim();
}

interface SpaceDay {
  space: SpaceRow;
  group: AvailabilityGroup;
  freeWindows: Array<{ start: string; end: string }>;
  nextOpen: string | null;
}

/** 1施設・1日の判定（占有区間マップ intervalsByDate から引く） */
function judgeDay(
  s: SpaceRow,
  ymd: string,
  intervals: ReadonlyArray<{ startTime: string; endTime: string; status: string }>,
  holidays: ReadonlyMap<string, string>,
  ctx: { today: string; now: string; earliest: string; cutoff: number },
): { group: AvailabilityGroup; freeWindows: Array<{ start: string; end: string }> } {
  const dayType = getDayType(ymd, holidays as ReadonlyMap<string, never>);
  const dayAvailable = dayType === 'weekend' ? !!s.weekend_available : !!s.weekday_available;
  const freeWindows = dayAvailable
    ? computeFreeWindows(intervals, s.open_time, s.close_time, s.slot_minutes || 30)
    : [];
  const hasTentative = intervals.some((b) => b.status === 'tentative');
  const { group } = classifySpaceDay({
    dayAvailable,
    freeWindows,
    hasTentative,
    dateYmd: ymd,
    todayYmd: ctx.today,
    earliestBookableDate: ctx.earliest,
    nowHHMM: ctx.now,
    cutoffHours: ctx.cutoff,
  });
  return { group, freeWindows };
}

export async function assembleAvailability(
  env: Env,
  dateYmd: string,
  filters: { use?: string; area?: string },
): Promise<AvailabilityResult> {
  const db = env.DB;
  const today = todayJST();
  const now = nowJST().slice(11, 16);
  const use = filters.use && filters.use !== 'all' ? filters.use : 'all';
  const area = filters.area && filters.area !== 'all' ? filters.area : 'all';

  const defaultDeadline = Number((await getSystemSetting(db, 'default_booking_deadline_days')) ?? '0');
  const lastSyncAt = await getSystemSetting(db, 'gcal_last_sync_at');

  let spaces = await getActiveSpaces(db);
  if (use !== 'all') spaces = spaces.filter((s) => (s.use_category ?? '').split(',').map((x) => x.trim()).includes(use));
  if (area !== 'all') spaces = spaces.filter((s) => s.area === area);

  // 対象日＋走査期間ぶんの占有を一括取得 → space→date→intervals
  const to = addDaysJST(dateYmd, NEXT_OPEN_SCAN_DAYS);
  const holidayFrom = dateYmd < today ? dateYmd : today;
  const [rows, holidays] = await Promise.all([
    getOccupyingBookingsAllSpaces(db, dateYmd, to),
    getHolidays(db, holidayFrom, to),
  ]);
  const map = new Map<string, Map<string, Array<{ startTime: string; endTime: string; status: string }>>>();
  for (const r of rows) {
    let byDate = map.get(r.space_id);
    if (!byDate) map.set(r.space_id, (byDate = new Map()));
    let arr = byDate.get(r.date);
    if (!arr) byDate.set(r.date, (arr = []));
    arr.push({ startTime: r.start_time, endTime: r.end_time, status: r.status });
  }
  const intervalsOf = (spaceId: string, ymd: string) => map.get(spaceId)?.get(ymd) ?? [];

  // 各施設の対象日判定＋「次の空き」
  // 1施設のデータ不備（例: 不正な営業時刻）で例外が出ても、その施設だけ「満室扱い」に
  // フォールバックしてページ全体は必ず描画する（空き状況ページの堅牢化）。
  const perSpace: SpaceDay[] = spaces.map((s) => {
    try {
      const leadDays = s.booking_deadline_days ?? defaultDeadline;
      const earliest = addDaysJST(today, leadDays);
      const ctx = { today, now, earliest, cutoff: s.same_day_cutoff_hours ?? 1 };
      const judged = judgeDay(s, dateYmd, intervalsOf(s.id, dateYmd), holidays, ctx);
      let nextOpen: string | null = null;
      if (judged.group !== 'ok') {
        for (let i = 1; i <= NEXT_OPEN_SCAN_DAYS; i++) {
          const d = addDaysJST(dateYmd, i);
          if (judgeDay(s, d, intervalsOf(s.id, d), holidays, ctx).group === 'ok') {
            nextOpen = d;
            break;
          }
        }
      }
      return { space: s, group: judged.group, freeWindows: judged.freeWindows, nextOpen };
    } catch (err) {
      console.log('[availability] space judge failed (fallback to full)', { spaceId: s.id, name: s.name, error: (err as Error).message });
      return { space: s, group: 'full' as AvailabilityGroup, freeWindows: [], nextOpen: null };
    }
  });

  // 同型グループでまとめる（room_group が同じものを1行に）
  const order = ['ok', 'talk', 'sameday', 'full'] as const;
  const rank = (g: AvailabilityGroup) => order.indexOf(g);
  const buckets = new Map<string, SpaceDay[]>();
  for (const sd of perSpace) {
    const key = sd.space.room_group ? `g:${sd.space.room_group}` : `s:${sd.space.id}`;
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(sd);
  }

  const isToday = dateYmd === today;
  const built: Array<{ row: AvailabilityRow; prio: number }> = [];
  for (const members of buckets.values()) {
    // 行の代表ステータス＝最も空いているメンバー
    members.sort((a, b) => rank(a.group) - rank(b.group));
    const best = members[0];
    const rep = best.space;
    const roomsTotal = members.length;
    const roomsFree = members.filter((m) => m.group === 'ok').length;
    const nextOpen =
      best.group === 'ok'
        ? null
        : members.map((m) => m.nextOpen).filter((x): x is string => !!x).sort()[0] ?? null;
    // 予約可能期間より先の日付は「閲覧のみ」＝ネット予約リンクは出さずお問い合わせへ（#77）
    const viewOnly = daysBetween(today, dateYmd) > (rep.booking_horizon_days ?? 180);
    // 予約受付最終日（閉鎖日）を過ぎた日は予約リンクを出さない（閉鎖予定施設）
    const beyondClosing = !!rep.closing_date && dateYmd > rep.closing_date;
    // 申込はお問い合わせのみ(inquiry_only)の施設も、他施設と同様に一度カレンダーへ遷移させる
    // （カレンダー側でお問い合わせ誘導＋サーバー側で予約作成を遮断）。ここでは特別扱いしない。
    const bookable = (best.group === 'ok' || best.group === 'talk') && !viewOnly && !beyondClosing;
    const bookingHref = bookable ? `/?space=${encodeURIComponent(rep.slug ?? rep.id)}&date=${dateYmd}` : null;
    // 直接予約できない行（閲覧のみ/商談中/満室等）でも、お問い合わせに直行せず一度カレンダーへ
    // 誘導するためのリンク。日付を付けてその月のカレンダーを開く（時刻選択の自動オープンは
    // カレンダー側で「予約可能な日だけ」に限定する）。
    const spaceHref = `/?space=${encodeURIComponent(rep.slug ?? rep.id)}&date=${dateYmd}`;
    const row: AvailabilityRow = {
      id: rep.room_group ? `group:${rep.room_group}` : rep.id,
      name: roomsTotal > 1 ? groupDisplayName(rep.name) : rep.name,
      area: rep.area,
      areaName: rep.area ? AREA_NAME[rep.area] ?? rep.area : '',
      useCategory: (rep.use_category ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      meta: rep.block_name ?? '',
      price: basePrice(rep),
      priceUnit: '円〜／時間',
      roomsTotal,
      roomsFree,
      status: best.group,
      closed: members.every((m) => m.freeWindows.length === 0) && best.group === 'full',
      freeWindows: best.freeWindows,
      nextOpen,
      bookingHref,
      spaceHref,
      viewOnly,
      imageUrl: rep.image_url ?? null,
    };
    const prio = isToday ? rep.same_day_priority ?? 100 : rep.sort_order;
    built.push({ row, prio });
  }

  const rowsFor = (g: AvailabilityGroup) =>
    built
      .filter((b) => b.row.status === g)
      .sort((a, b) => a.prio - b.prio)
      .map((b) => b.row);
  const groups = { ok: rowsFor('ok'), talk: rowsFor('talk'), sameday: rowsFor('sameday'), full: rowsFor('full') };
  const total = built.length;

  return {
    date: dateYmd,
    weekdayLabel: weekdayLabelOf(dateYmd),
    isToday,
    lastSyncAt,
    filters: { use, area },
    counts: { open: groups.ok.length, total },
    groups,
  };
}
