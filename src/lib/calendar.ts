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
