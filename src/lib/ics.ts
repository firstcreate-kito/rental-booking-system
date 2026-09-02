/**
 * iCalendar（.ics）生成。予約確定メール等に添付し、お客様がGoogle/Apple/Outlookの
 * カレンダーへワンタップで追加できるようにする。
 *
 * 設計メモ：
 * - 日本時間（JST=UTC+9・夏時間なし）で入力し、UTC（末尾Z）へ変換して出力する。
 *   VTIMEZONE不要で全クライアントが正しく解釈できる。
 * - 予約1件に複数日程（複数枠）がある場合、日程ごとに VEVENT を作る。
 * - UID は「予約番号＋枠の連番」で安定させる。日時変更（reschedule）時に同じUID＋
 *   より大きい SEQUENCE で再送すると、対応クライアントでは既存予定が更新される。
 * - キャンセルは METHOD:CANCEL＋STATUS:CANCELLED で送る（対応クライアントで削除/取消）。
 * - RFC5545: テキスト値は , ; \ と改行をエスケープ。行末は CRLF。
 */

export interface IcsDay {
  date: string; // 'YYYY-MM-DD'
  startTime: string; // 'HH:MM'
  endTime: string; // 'HH:MM'（'24:00' は翌日0:00として扱う）
}

export interface BookingIcsInput {
  bookingNumber: string;
  spaceName: string;
  days: ReadonlyArray<IcsDay>;
  /** 予約の確認・変更ページURL（説明文に載せる・任意） */
  url?: string;
  /** 'add'（追加/更新・既定）または 'cancel'（取消） */
  mode?: 'add' | 'cancel';
  /** 更新時刻の目安（SEQUENCE生成用。既定 Date.now()）。同一UIDで再送するほど大きくする */
  now?: number;
  /** ドメイン（UID生成用・既定 booking.space-albe.com） */
  domain?: string;
}

/** RFC5545 テキストエスケープ（, ; \ と改行）。 */
export function escapeIcsText(s: string): string {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** JSTの日付・時刻を iCalendar のUTCタイムスタンプ（YYYYMMDDTHHMMSSZ）へ変換する。 */
export function jstToIcsUtc(dateYmd: string, hhmm: string): string {
  const [y, mo, d] = dateYmd.split('-').map((n) => parseInt(n, 10));
  const [hh, mm] = hhmm.split(':').map((n) => parseInt(n, 10));
  // JST(UTC+9) を UTC へ：UTCミリ秒として組み立てて 9時間引く。hh=24（24:00）は翌日へ繰り上がる。
  const utcMs = Date.UTC(y, mo - 1, d, hh, mm, 0) - 9 * 3600 * 1000;
  const dt = new Date(utcMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}` +
    `T${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}${p(dt.getUTCSeconds())}Z`
  );
}

/** 予約1件分の VCALENDAR 文字列を生成する。 */
export function buildBookingIcs(input: BookingIcsInput): string {
  const domain = input.domain || 'booking.space-albe.com';
  const cancel = input.mode === 'cancel';
  const now = input.now ?? Date.now();
  // SEQUENCE：分単位の経過値（32bit内）。再送ごとに増加し、対応クライアントで更新扱いになる。
  const sequence = Math.floor(now / 60000) % 2000000000;
  const summary = escapeIcsText(`レンタルスペースALBE ご予約（${input.spaceName}）`);
  const descLines = [`予約番号: ${input.bookingNumber}`];
  if (input.url) descLines.push(`ご予約の確認・変更: ${input.url}`);
  const description = escapeIcsText(descLines.join('\n'));
  const location = escapeIcsText(input.spaceName);

  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rental Space ALBE//Booking//JA',
    'CALSCALE:GREGORIAN',
    `METHOD:${cancel ? 'CANCEL' : 'PUBLISH'}`,
  ];
  const events = input.days.map((d, i) => {
    const uid = `${input.bookingNumber}-${i}@${domain}`;
    return [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dtstampNow(now)}`,
      `SEQUENCE:${sequence}`,
      `DTSTART:${jstToIcsUtc(d.date, d.startTime)}`,
      `DTEND:${jstToIcsUtc(d.date, d.endTime)}`,
      `SUMMARY:${summary}`,
      `LOCATION:${location}`,
      `DESCRIPTION:${description}`,
      `STATUS:${cancel ? 'CANCELLED' : 'CONFIRMED'}`,
      cancel ? 'TRANSP:TRANSPARENT' : 'TRANSP:OPAQUE',
      'END:VEVENT',
    ].join('\r\n');
  });
  return [...head, ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

/** now(ミリ秒) を DTSTAMP 用のUTC表記へ。 */
function dtstampNow(now: number): string {
  const dt = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}` +
    `T${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}${p(dt.getUTCSeconds())}Z`
  );
}

/** UTF-8文字列をbase64へ（Workers環境・Resend添付用）。 */
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * 予約用の .ics 添付（Resendの attachments 形式）を返す。日程が無ければ null。
 * filename は予約番号入り。base64 の content とともに返す。
 */
export function bookingIcsAttachment(
  input: BookingIcsInput,
): { filename: string; content: string; contentType: string } | null {
  if (!input.days || input.days.length === 0) return null;
  const ics = buildBookingIcs(input);
  return {
    filename: `booking-${input.bookingNumber}.ics`,
    content: utf8ToBase64(ics),
    contentType: 'text/calendar; charset=utf-8; method=' + (input.mode === 'cancel' ? 'CANCEL' : 'PUBLISH'),
  };
}
