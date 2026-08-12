/**
 * 時刻・時間に関するユーティリティ（'HH:MM' 前提）
 */

/** 'HH:MM' を 0時からの分数に変換 */
export function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`invalid time format: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) {
    throw new Error(`out-of-range time: ${hhmm}`);
  }
  return h * 60 + min;
}

/** 開始→終了の差（時間・小数可）。例: 10:00→18:30 = 8.5 */
export function diffHours(start: string, end: string): number {
  return (toMinutes(end) - toMinutes(start)) / 60;
}

/** 時間数を1時間単位に切り上げ。例: 8.5 → 9 */
export function ceilHours(hours: number): number {
  // 浮動小数の誤差を吸収してから切り上げ
  return Math.ceil(hours - 1e-9);
}

/** 開始・終了が 00分 または 30分 単位か */
export function isHalfHourAligned(hhmm: string): boolean {
  const min = toMinutes(hhmm) % 60;
  return min === 0 || min === 30;
}
