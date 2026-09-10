/**
 * サイネージ表示名・時刻フォーマットの共通ロジック（#124）。
 * 方針（オーナー確定）：
 *  - イベント名があればイベント名を優先表示。
 *  - 無ければ「苗字（姓）だけ ＋ 様」で表示（個人名の下の名前は出さない＝プライバシー配慮）。
 *  - 時刻は「10:00～11:00」の形式。
 * contact_name は予約フォームで「姓 名」を半角スペースで連結して保存している。
 */

/** contact_name（"姓 名"）から苗字（姓）だけを取り出す。空白（半角/全角）で分割し先頭を採用。 */
export function signageLastName(contactName: string | null | undefined): string {
  const s = String(contactName ?? '').trim();
  if (!s) return '';
  const first = s.split(/[\s　]+/).filter(Boolean)[0];
  return first || s;
}

/**
 * サイネージに出す表示名を決める。
 * - eventName があればそのまま（前後空白は除去）。
 * - 無ければ「<姓> 様」。姓も取れなければ「予約あり」。
 */
export function signageDisplayName(eventName: string | null | undefined, contactName: string | null | undefined): string {
  const ev = String(eventName ?? '').trim();
  if (ev) return ev;
  const ln = signageLastName(contactName);
  return ln ? `${ln} 様` : '予約あり';
}

/** 'HH:MM' 2つを「10:00～11:00」形式にする。 */
export function signageTimeRange(startTime: string, endTime: string): string {
  return `${startTime}～${endTime}`;
}

export interface SignageDisplayItem {
  label: string; // 表示名（イベント名 or 姓+様）
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
  range: string; // '10:00～11:00'
  status: 'ongoing' | 'upcoming';
}

/**
 * 当日の確定予約行（開始/終了/イベント名/氏名）から、サイネージ表示用の配列を作る。
 * - 終了済み（end <= now）は除外。
 * - now が [start, end) に入っていれば ongoing、そうでなければ upcoming。
 * - 開始時刻順（既にSQLでソート済みでも安定のため再ソート）。
 */
export function buildSignageItems(
  rows: { start_time: string; end_time: string; event_name: string | null; contact_name?: string | null }[],
  nowHHMM: string,
): SignageDisplayItem[] {
  return rows
    .filter((r) => r.end_time > nowHHMM)
    .slice()
    .sort((a, b) => (a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : 0))
    .map((r) => ({
      label: signageDisplayName(r.event_name, r.contact_name),
      start: r.start_time,
      end: r.end_time,
      range: signageTimeRange(r.start_time, r.end_time),
      status: r.start_time <= nowHHMM ? ('ongoing' as const) : ('upcoming' as const),
    }));
}
