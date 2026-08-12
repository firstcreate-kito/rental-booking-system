/**
 * D1 データアクセス層（Phase 1 で使う分）
 */
import type { HolidayType } from '../lib/calendar';

/** spaces テーブルの行 */
export interface SpaceRow {
  id: string;
  name: string;
  name_en: string | null;
  google_calendar_id: string | null;
  billing_type: 'hourly' | 'block';
  weekday_rate: number | null;
  weekend_rate: number | null;
  day_rate_hours: number | null;
  weekday_available: number;
  weekend_available: number;
  slot_minutes: number;
  has_minimum: number;
  min_hours: number;
  open_time: string;
  close_time: string;
  booking_horizon_days: number;
  booking_deadline_days: number | null;
  block_name: string | null;
  sort_order: number;
  is_active: number;
}

export interface BookingIntervalRow {
  date: string;
  start_time: string;
  end_time: string;
  status: string;
}

export async function getActiveSpaces(db: D1Database): Promise<SpaceRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM spaces WHERE is_active = 1 ORDER BY sort_order')
    .all<SpaceRow>();
  return results ?? [];
}

export async function getSpaceById(db: D1Database, id: string): Promise<SpaceRow | null> {
  return db.prepare('SELECT * FROM spaces WHERE id = ?').bind(id).first<SpaceRow>();
}

/** 期間内の祝日・休業日（calendar_holidays）を Map<date, type> で返す */
export async function getHolidays(
  db: D1Database,
  startDate: string,
  endDate: string,
): Promise<Map<string, HolidayType>> {
  const { results } = await db
    .prepare('SELECT date, type FROM calendar_holidays WHERE date >= ? AND date <= ?')
    .bind(startDate, endDate)
    .all<{ date: string; type: HolidayType }>();
  const map = new Map<string, HolidayType>();
  for (const r of results ?? []) map.set(r.date, r.type);
  return map;
}

/** スペース固有の休業日を Set<date> で返す */
export async function getSpaceClosures(
  db: D1Database,
  spaceId: string,
  startDate: string,
  endDate: string,
): Promise<Set<string>> {
  const { results } = await db
    .prepare('SELECT date FROM space_closures WHERE space_id = ? AND date >= ? AND date <= ?')
    .bind(spaceId, startDate, endDate)
    .all<{ date: string }>();
  return new Set((results ?? []).map((r) => r.date));
}

export interface SeasonalRuleRow {
  start_date: string;
  end_date: string;
  surcharge_pct: number;
}

export async function getActiveSeasonalRules(db: D1Database): Promise<SeasonalRuleRow[]> {
  const { results } = await db
    .prepare('SELECT start_date, end_date, surcharge_pct FROM seasonal_pricing WHERE is_active = 1')
    .all<SeasonalRuleRow>();
  return results ?? [];
}

/** スペースの、指定期間の占有予約（confirmed/tentative/blocked/held）を返す */
export async function getSpaceBookingsInRange(
  db: D1Database,
  spaceId: string,
  startDate: string,
  endDate: string,
): Promise<BookingIntervalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT date, start_time, end_time, status FROM bookings
       WHERE space_id = ? AND date >= ? AND date <= ?
         AND status IN ('confirmed','tentative','blocked','held')`,
    )
    .bind(spaceId, startDate, endDate)
    .all<BookingIntervalRow>();
  return results ?? [];
}

/** 指定日の占有予約のみ（競合チェック用） */
export async function getSpaceBookingsOnDate(
  db: D1Database,
  spaceId: string,
  date: string,
): Promise<BookingIntervalRow[]> {
  return getSpaceBookingsInRange(db, spaceId, date, date);
}

/** system_settings を Map で返す */
export async function getSystemSettings(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db
    .prepare('SELECT key, value FROM system_settings')
    .all<{ key: string; value: string }>();
  const map = new Map<string, string>();
  for (const r of results ?? []) map.set(r.key, r.value);
  return map;
}

/** ブラックリストに該当するか（email/phone） */
export async function isBlacklisted(
  db: D1Database,
  email: string,
  phone: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM blacklist
       WHERE (type = 'email' AND value = ?) OR (type = 'phone' AND value = ?) LIMIT 1`,
    )
    .bind(email, phone)
    .first<{ hit: number }>();
  return !!row;
}

/** 顧客をメールで検索。なければ null */
export async function getCustomerByEmail(
  db: D1Database,
  email: string,
): Promise<{ id: string; is_blocked: number } | null> {
  return db
    .prepare('SELECT id, is_blocked FROM customers WHERE email = ?')
    .bind(email)
    .first<{ id: string; is_blocked: number }>();
}

/**
 * 当日の次の予約番号連番（YYYYMMDD-NNN の NNN）を求める。
 * 実際の重複防止は INSERT 時の UNIQUE 制約 + リトライで担保する。
 */
export async function peekNextBookingSeq(db: D1Database, ymd: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT booking_number FROM booking_groups
       WHERE booking_number LIKE ? ORDER BY booking_number DESC LIMIT 1`,
    )
    .bind(`${ymd}-%`)
    .first<{ booking_number: string }>();
  if (!row) return 1;
  const seq = Number(row.booking_number.split('-')[1] ?? '0');
  return seq + 1;
}
