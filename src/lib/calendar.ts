/**
 * 日付の区分判定（平日 / 土日祝）と、予約可否に関わる休業判定
 */

/** calendar_holidays.type */
export type HolidayType = 'holiday' | 'custom' | 'closed';

/** 曜日区分（料金の平日/土日祝に対応） */
export type DayType = 'weekday' | 'weekend';

/**
 * 'YYYY-MM-DD' から曜日番号(0=日〜6=土)を取得。
 * タイムゾーンの影響を避けるため UTC 正午で生成する。
 */
export function dayOfWeek(dateISO: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!m) throw new Error(`invalid date format: ${dateISO}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.getUTCDay();
}

/** 'YYYY-MM-DD' を UTC正午の Date に変換 */
function toUTCDate(dateISO: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!m) throw new Error(`invalid date format: ${dateISO}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

/** Date を 'YYYY-MM-DD' に変換（UTC基準） */
export function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** a から b までの日数（b - a）。同日=0、翌日=1 */
export function daysBetween(aISO: string, bISO: string): number {
  const a = toUTCDate(aISO).getTime();
  const b = toUTCDate(bISO).getTime();
  return Math.round((b - a) / 86400000);
}

/** dateISO に days 日加算した 'YYYY-MM-DD' */
export function addDays(dateISO: string, days: number): string {
  const d = toUTCDate(dateISO);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

/** その月の全日付 'YYYY-MM-DD' を返す（month: 'YYYY-MM'） */
export function datesInMonth(month: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`invalid month format: ${month}`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate(); // 翌月0日=当月末日
  const result: string[] = [];
  for (let d = 1; d <= days; d++) {
    result.push(`${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return result;
}

/** 土日か */
export function isWeekend(dateISO: string): boolean {
  const dow = dayOfWeek(dateISO);
  return dow === 0 || dow === 6;
}

/**
 * 曜日区分を判定。
 * - 土日 → weekend
 * - 祝日/独自休日(type: 'holiday' | 'custom') → weekend 料金
 * - それ以外 → weekday
 * @param holidays 日付 → type のマップ（calendar_holidays）
 */
export function getDayType(
  dateISO: string,
  holidays?: ReadonlyMap<string, HolidayType>,
): DayType {
  const holidayType = holidays?.get(dateISO);
  if (holidayType === 'holiday' || holidayType === 'custom') return 'weekend';
  return isWeekend(dateISO) ? 'weekend' : 'weekday';
}

/**
 * その日が予約不可（休業）かどうか。
 * - calendar_holidays.type === 'closed'
 * - space_closures に該当（スペース固有休業）
 */
export function isClosed(
  dateISO: string,
  opts: {
    holidays?: ReadonlyMap<string, HolidayType>;
    spaceClosureDates?: ReadonlySet<string>;
  },
): boolean {
  if (opts.holidays?.get(dateISO) === 'closed') return true;
  if (opts.spaceClosureDates?.has(dateISO)) return true;
  return false;
}
