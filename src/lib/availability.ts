/**
 * 空き状況（カレンダー○△✕）判定と、予約入力のバリデーション
 */
import { toMinutes, isHalfHourAligned } from './time';
import { daysBetween, type DayType } from './calendar';

/** 予約枠を占有するステータス（キャンセルは除外） */
export const OCCUPYING_STATUSES = ['confirmed', 'tentative', 'blocked', 'held'] as const;

/** 稼働状況 */
export type AvailabilityStatus =
  | 'available' // ○ 空きが閾値以上
  | 'limited' // △ 空きが1〜閾値未満
  | 'full' // ✕ 満枠
  | 'closed'; // 休業

/** 既存予約の時間帯（占有判定用） */
export interface OccupyingInterval {
  startTime: string; // 'HH:MM'
  endTime: string; // 'HH:MM'
  status: string;
}

export interface DayAvailabilityInput {
  billingType: 'hourly' | 'block';
  openTime: string;
  closeTime: string;
  slotMinutes: number;
  isClosed: boolean; // 休業日か
  dayAvailable: boolean; // その曜日区分で提供するか
  bookings: readonly OccupyingInterval[];
  /** 空き○の閾値（%）。デフォルト50 */
  thresholdPct?: number;
}

export interface DayAvailabilityResult {
  status: AvailabilityStatus;
  hasTentative: boolean; // 商談中の予約が含まれるか
  freeSlots: number;
  totalSlots: number;
}

/** '✕'などの記号表現 */
export function statusSymbol(status: AvailabilityStatus): string {
  switch (status) {
    case 'available':
      return '○';
    case 'limited':
      return '△';
    case 'full':
      return '✕';
    case 'closed':
      return '−';
  }
}

/** 営業時間内の総スロット数 */
export function slotCount(openTime: string, closeTime: string, slotMinutes: number): number {
  const span = toMinutes(closeTime) - toMinutes(openTime);
  return Math.max(0, Math.floor(span / slotMinutes));
}

/**
 * 1日分の稼働状況を判定する。
 */
export function computeDayAvailability(input: DayAvailabilityInput): DayAvailabilityResult {
  const occupying = input.bookings.filter((b) =>
    (OCCUPYING_STATUSES as readonly string[]).includes(b.status),
  );
  const hasTentative = occupying.some((b) => b.status === 'tentative');

  if (input.isClosed || !input.dayAvailable) {
    return { status: 'closed', hasTentative, freeSlots: 0, totalSlots: 0 };
  }

  // ブロック単位スペース: 予約ありで✕、なしで○
  if (input.billingType === 'block') {
    const full = occupying.length > 0;
    return {
      status: full ? 'full' : 'available',
      hasTentative,
      freeSlots: full ? 0 : 1,
      totalSlots: 1,
    };
  }

  const total = slotCount(input.openTime, input.closeTime, input.slotMinutes);
  if (total <= 0) {
    return { status: 'closed', hasTentative, freeSlots: 0, totalSlots: 0 };
  }

  const openMin = toMinutes(input.openTime);
  const occupied = new Array<boolean>(total).fill(false);
  for (const b of occupying) {
    const s = Math.max(0, Math.floor((toMinutes(b.startTime) - openMin) / input.slotMinutes));
    const e = Math.min(total, Math.ceil((toMinutes(b.endTime) - openMin) / input.slotMinutes));
    for (let i = s; i < e; i++) occupied[i] = true;
  }
  const usedSlots = occupied.filter(Boolean).length;
  const freeSlots = total - usedSlots;
  const freeRatio = freeSlots / total;
  const threshold = (input.thresholdPct ?? 50) / 100;

  let status: AvailabilityStatus;
  if (freeSlots <= 0) status = 'full';
  else if (freeRatio >= threshold) status = 'available';
  else status = 'limited';

  return { status, hasTentative, freeSlots, totalSlots: total };
}

/** 分を 'HH:MM' に戻す */
function fromMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 空き時間帯（連続した空き）を 'HH:MM'〜'HH:MM' の配列で返す（#74・緩い判定/表示用） */
export function computeFreeWindows(
  occupying: ReadonlyArray<{ startTime: string; endTime: string; status: string }>,
  openTime: string,
  closeTime: string,
  slotMinutes: number,
): Array<{ start: string; end: string }> {
  const openMin = toMinutes(openTime);
  const closeMin = toMinutes(closeTime);
  const total = Math.max(0, Math.floor((closeMin - openMin) / slotMinutes));
  if (total <= 0) return [];
  const occ = occupying.filter((b) => (OCCUPYING_STATUSES as readonly string[]).includes(b.status));
  const occupied = new Array<boolean>(total).fill(false);
  for (const b of occ) {
    const s = Math.max(0, Math.floor((toMinutes(b.startTime) - openMin) / slotMinutes));
    const e = Math.min(total, Math.ceil((toMinutes(b.endTime) - openMin) / slotMinutes));
    for (let i = s; i < e; i++) occupied[i] = true;
  }
  const windows: Array<{ start: string; end: string }> = [];
  let runStart = -1;
  for (let i = 0; i < total; i++) {
    if (!occupied[i] && runStart < 0) runStart = i;
    if ((occupied[i] || i === total - 1) && runStart >= 0) {
      const endIdx = occupied[i] ? i : i + 1;
      windows.push({
        start: fromMinutes(openMin + runStart * slotMinutes),
        end: fromMinutes(openMin + endIdx * slotMinutes),
      });
      runStart = -1;
    }
  }
  return windows;
}

/** 空き状況ページのグループ（#74）: 空きあり/商談中/当日不可/満室 */
export type AvailabilityGroup = 'ok' | 'talk' | 'sameday' | 'full';

/**
 * 1施設・1日の表示グループを判定する（#74・緩い判定）。純粋関数（テスト用）。
 *  - 休業・満室（空き0） → full
 *  - 空きあり だが 受付不可（締切日数/当日締切超過） → sameday
 *  - 空きあり・受付可・商談中を含む → talk
 *  - 空きあり・受付可 → ok
 */
export function classifySpaceDay(p: {
  dayAvailable: boolean;
  freeWindows: ReadonlyArray<{ start: string; end: string }>;
  hasTentative: boolean;
  dateYmd: string;
  todayYmd: string;
  earliestBookableDate: string; // today + 締切日数
  nowHHMM: string;
  cutoffHours: number; // 当日は開始のN時間前まで
}): { group: AvailabilityGroup; bookable: boolean } {
  if (!p.dayAvailable) return { group: 'full', bookable: false };
  if (p.freeWindows.length === 0) return { group: 'full', bookable: false };

  let bookable: boolean;
  if (p.dateYmd < p.earliestBookableDate) {
    bookable = false; // 締切（N日前まで）を過ぎている／当日受付なし
  } else if (p.dateYmd === p.todayYmd) {
    // 当日：締切（今＋cutoff時間）より後まで続く空き枠が1つでもあれば受付可
    // （枠の開始が締切より前でも、締切以降に予約可能な時間が残っていればよい）
    const limit = toMinutes(p.nowHHMM) + p.cutoffHours * 60;
    bookable = p.freeWindows.some((w) => toMinutes(w.end) > limit);
  } else {
    bookable = true;
  }

  if (!bookable) return { group: 'sameday', bookable: false };
  if (p.hasTentative) return { group: 'talk', bookable: true };
  return { group: 'ok', bookable: true };
}

// ---------------------------------------------------------------------------
// 予約入力バリデーション
// ---------------------------------------------------------------------------

export interface BookingValidationSpace {
  openTime: string;
  closeTime: string;
  slotMinutes: number;
  bookingHorizonDays: number;
  bookingDeadlineDays: number | null; // NULLなら defaultDeadlineDays
  weekdayAvailable: boolean;
  weekendAvailable: boolean;
}

export interface BookingItemInput {
  date: string; // 'YYYY-MM-DD'
  startTime: string; // 'HH:MM'
  endTime: string; // 'HH:MM'
}

export interface ValidationContext {
  today: string; // 'YYYY-MM-DD'
  dayType: DayType;
  isClosed: boolean;
  defaultDeadlineDays: number; // system_settings
}

export interface ValidationError {
  code: string;
  message: string;
}

/**
 * 1件の予約日程を検証。エラーの配列を返す（空なら妥当）。
 * ※最低利用時間は「予約は可能・料金だけ最低時間」なのでここでは弾かない。
 */
export function validateBookingItem(
  space: BookingValidationSpace,
  item: BookingItemInput,
  ctx: ValidationContext,
): ValidationError[] {
  const errors: ValidationError[] = [];

  // 30分単位
  if (!isHalfHourAligned(item.startTime) || !isHalfHourAligned(item.endTime)) {
    errors.push({ code: 'NOT_ALIGNED', message: '開始・終了は00分または30分で指定してください' });
  }

  // 開始 < 終了
  if (toMinutes(item.startTime) >= toMinutes(item.endTime)) {
    errors.push({ code: 'INVALID_RANGE', message: '終了時刻は開始時刻より後にしてください' });
  }

  // 営業時間内
  if (
    toMinutes(item.startTime) < toMinutes(space.openTime) ||
    toMinutes(item.endTime) > toMinutes(space.closeTime)
  ) {
    errors.push({ code: 'OUT_OF_HOURS', message: '営業時間外は予約できません' });
  }

  // 休業日
  if (ctx.isClosed) {
    errors.push({ code: 'CLOSED', message: 'この日は休業日です' });
  }

  // 曜日区分の提供可否
  const available = ctx.dayType === 'weekend' ? space.weekendAvailable : space.weekdayAvailable;
  if (!available) {
    errors.push({ code: 'DAY_UNAVAILABLE', message: 'この曜日は予約対象外です' });
  }

  // 予約可能期間・締切
  const diff = daysBetween(ctx.today, item.date);
  if (diff < 0) {
    errors.push({ code: 'PAST_DATE', message: '過去の日付は予約できません' });
  } else {
    if (diff > space.bookingHorizonDays) {
      errors.push({
        code: 'BEYOND_HORIZON',
        message: `予約可能期間（${space.bookingHorizonDays}日先まで）を超えています`,
      });
    }
    const deadline = space.bookingDeadlineDays ?? ctx.defaultDeadlineDays;
    if (diff < deadline) {
      errors.push({
        code: 'PAST_DEADLINE',
        message: `予約受付は利用日の${deadline}日前までです`,
      });
    }
  }

  return errors;
}

/** 2つの時間帯が重なるか（[start,end)） */
export function intervalsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return toMinutes(aStart) < toMinutes(bEnd) && toMinutes(bStart) < toMinutes(aEnd);
}
