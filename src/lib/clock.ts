/**
 * 日本時間（JST, UTC+9）基準の日付・日時ユーティリティ
 * ALBEは日本国内運用のため、業務日付はJSTで扱う。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 現在のJST日時（内部計算用に UTC時刻へ+9したDate） */
function jstNow(now: number): Date {
  return new Date(now + JST_OFFSET_MS);
}

/** JSTの今日 'YYYY-MM-DD' */
export function todayJST(now: number = Date.now()): string {
  const d = jstNow(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** JSTの今日を 'YYYYMMDD'（予約番号用） */
export function todayYmdJST(now: number = Date.now()): string {
  return todayJST(now).replace(/-/g, '');
}

/** JSTの現在日時 'YYYY-MM-DD HH:MM:SS' */
export function nowJST(now: number = Date.now()): string {
  const d = jstNow(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
