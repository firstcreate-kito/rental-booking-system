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

/** 指定日の占有予約（自グループを除く。日時変更の競合チェック用） */
export async function getOccupyingIntervalsExcludingGroup(
  db: D1Database,
  spaceId: string,
  date: string,
  excludeGroupId: string,
): Promise<Array<{ start_time: string; end_time: string }>> {
  const { results } = await db
    .prepare(
      `SELECT start_time, end_time FROM bookings
       WHERE space_id = ? AND date = ? AND group_id != ?
         AND status IN ('confirmed','tentative','blocked','held')`,
    )
    .bind(spaceId, date, excludeGroupId)
    .all<{ start_time: string; end_time: string }>();
  return results ?? [];
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

export interface CustomerAuthRow {
  id: string;
  email: string;
  password_hash: string | null;
  is_registered: number;
  is_blocked: number;
  contact_name: string;
  status_id: string;
}

/** 認証用に顧客をメールで取得（パスワードハッシュ含む） */
export async function getCustomerAuthByEmail(
  db: D1Database,
  email: string,
): Promise<CustomerAuthRow | null> {
  return db
    .prepare(
      'SELECT id, email, password_hash, is_registered, is_blocked, contact_name, status_id FROM customers WHERE email = ?',
    )
    .bind(email)
    .first<CustomerAuthRow>();
}

export async function updateLastLogin(db: D1Database, customerId: string, now: string): Promise<void> {
  await db.prepare('UPDATE customers SET last_login_at = ? WHERE id = ?').bind(now, customerId).run();
}

// --- セッション ---
export async function createSession(
  db: D1Database,
  token: string,
  customerId: string,
  expiresAt: string,
  now: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO auth_sessions (token, customer_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(token, customerId, expiresAt, now)
    .run();
}

export interface SessionCustomerRow {
  id: string;
  email: string;
  contact_name: string;
  status_id: string;
  is_registered: number;
  is_blocked: number;
  expires_at: string;
}

/** トークンからセッション+顧客を取得 */
export async function getSessionCustomer(
  db: D1Database,
  token: string,
): Promise<SessionCustomerRow | null> {
  return db
    .prepare(
      `SELECT c.id, c.email, c.contact_name, c.status_id, c.is_registered, c.is_blocked, s.expires_at
       FROM auth_sessions s JOIN customers c ON c.id = s.customer_id
       WHERE s.token = ?`,
    )
    .bind(token)
    .first<SessionCustomerRow>();
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(token).run();
}

// --- マイページ ---
export async function getCustomerProfile(db: D1Database, customerId: string) {
  return db
    .prepare(
      `SELECT id, email, company_name, contact_name, phone, postal_code, address, invoice_number,
              status_id, point_balance, is_registered, created_at, last_login_at
       FROM customers WHERE id = ?`,
    )
    .bind(customerId)
    .first();
}

export async function updateCustomerProfile(
  db: D1Database,
  customerId: string,
  fields: { companyName?: string | null; contactName?: string; phone?: string; postalCode?: string | null; address?: string | null; invoiceNumber?: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE customers SET
        company_name = COALESCE(?, company_name),
        contact_name = COALESCE(?, contact_name),
        phone = COALESCE(?, phone),
        postal_code = COALESCE(?, postal_code),
        address = COALESCE(?, address),
        invoice_number = COALESCE(?, invoice_number)
       WHERE id = ?`,
    )
    .bind(
      fields.companyName ?? null,
      fields.contactName ?? null,
      fields.phone ?? null,
      fields.postalCode ?? null,
      fields.address ?? null,
      fields.invoiceNumber ?? null,
      customerId,
    )
    .run();
}

export async function updateCustomerPassword(
  db: D1Database,
  customerId: string,
  passwordHash: string,
): Promise<void> {
  await db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').bind(passwordHash, customerId).run();
}

/** 顧客の予約履歴（グループ単位） */
export async function getCustomerBookingGroups(db: D1Database, customerId: string) {
  const { results } = await db
    .prepare(
      `SELECT bg.booking_number, bg.space_id, s.name AS space_name, bg.event_name,
              bg.total_amount, bg.status, bg.created_at,
              MIN(b.date) AS first_date, MAX(b.date) AS last_date, COUNT(b.id) AS day_count
       FROM booking_groups bg
       LEFT JOIN bookings b ON b.group_id = bg.id
       LEFT JOIN spaces s ON s.id = bg.space_id
       WHERE bg.customer_id = ?
       GROUP BY bg.id
       ORDER BY bg.created_at DESC`,
    )
    .bind(customerId)
    .all();
  return results ?? [];
}

export async function getPointBalanceAndLog(db: D1Database, customerId: string) {
  const balance = await db
    .prepare('SELECT point_balance FROM customers WHERE id = ?')
    .bind(customerId)
    .first<{ point_balance: number }>();
  const { results: log } = await db
    .prepare(
      `SELECT type, amount, balance_after, description, created_at
       FROM point_log WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
    .bind(customerId)
    .all();
  return { balance: balance?.point_balance ?? 0, log: log ?? [] };
}

export async function getFavorites(db: D1Database, customerId: string) {
  const { results } = await db
    .prepare(
      `SELECT cf.space_id, s.name AS space_name FROM customer_favorites cf
       JOIN spaces s ON s.id = cf.space_id WHERE cf.customer_id = ? ORDER BY cf.created_at DESC`,
    )
    .bind(customerId)
    .all();
  return results ?? [];
}

export async function addFavorite(db: D1Database, customerId: string, spaceId: string, now: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO customer_favorites (customer_id, space_id, created_at) VALUES (?, ?, ?)')
    .bind(customerId, spaceId, now)
    .run();
}

export async function removeFavorite(db: D1Database, customerId: string, spaceId: string): Promise<void> {
  await db
    .prepare('DELETE FROM customer_favorites WHERE customer_id = ? AND space_id = ?')
    .bind(customerId, spaceId)
    .run();
}

export interface BookingGroupRow {
  id: string;
  booking_number: string;
  customer_id: string | null;
  space_id: string;
  event_name: string;
  total_amount: number;
  status: string;
  source: string;
  reschedule_count: number;
  created_at: string;
}

export interface BookingRow {
  id: string;
  group_id: string;
  space_id: string;
  date: string;
  start_time: string;
  end_time: string;
  billable_hours: number;
  billing_mode: string;
  is_residence: number;
  rate: number | null;
  price: number;
  status: string;
}

export async function getBookingGroupByNumber(
  db: D1Database,
  bookingNumber: string,
): Promise<BookingGroupRow | null> {
  return db
    .prepare('SELECT * FROM booking_groups WHERE booking_number = ?')
    .bind(bookingNumber)
    .first<BookingGroupRow>();
}

export async function getBookingsByGroup(db: D1Database, groupId: string): Promise<BookingRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM bookings WHERE group_id = ? ORDER BY date, start_time')
    .bind(groupId)
    .all<BookingRow>();
  return results ?? [];
}

export interface OptionRow {
  id: string;
  name: string;
  category: string;
  type: 'toggle' | 'quantity';
  price_type: 'free' | 'fixed' | 'per_unit';
  unit_price: number;
  unit_label: string | null;
  max_qty: number | null;
  stock_total: number | null;
  scope: 'per_booking' | 'per_group';
  sort_order: number;
  is_active: number;
}

/** スペースで有効なオプション一覧 */
export async function getSpaceOptions(db: D1Database, spaceId: string): Promise<OptionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT o.* FROM options o
       JOIN space_options so ON so.option_id = o.id
       WHERE so.space_id = ? AND so.is_active = 1 AND o.is_active = 1
       ORDER BY o.sort_order`,
    )
    .bind(spaceId)
    .all<OptionRow>();
  return results ?? [];
}

/** ID群からオプション詳細を取得 */
export async function getOptionsByIds(db: D1Database, ids: string[]): Promise<Map<string, OptionRow>> {
  const map = new Map<string, OptionRow>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM options WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<OptionRow>();
  for (const r of results ?? []) map.set(r.id, r);
  return map;
}

/** あるオプションが、あるスペースで利用可能か */
export async function isOptionAvailableForSpace(
  db: D1Database,
  spaceId: string,
  optionId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM space_options
       WHERE space_id = ? AND option_id = ? AND is_active = 1 LIMIT 1`,
    )
    .bind(spaceId, optionId)
    .first<{ ok: number }>();
  return !!row;
}

/**
 * 指定オプションの、指定日の利用数合計（共通在庫は全スペース横断で集計）。
 * per_booking はその日のbooking、per_group はその日に予約があるグループの選択を集計。
 * @param excludeGroupId 除外するグループ（日時変更時の自グループ除外用）
 */
export async function getDailyOptionUsage(
  db: D1Database,
  optionId: string,
  date: string,
  excludeGroupId?: string,
): Promise<number> {
  const exclude = excludeGroupId ?? '';
  const perBooking = await db
    .prepare(
      `SELECT COALESCE(SUM(bos.quantity),0) AS q
       FROM booking_option_selections bos
       JOIN bookings b ON b.id = bos.booking_id
       WHERE bos.option_id = ? AND b.date = ?
         AND b.status IN ('confirmed','tentative','blocked','held')
         AND b.group_id != ?`,
    )
    .bind(optionId, date, exclude)
    .first<{ q: number }>();
  const perGroup = await db
    .prepare(
      `SELECT COALESCE(SUM(bos.quantity),0) AS q
       FROM booking_option_selections bos
       WHERE bos.option_id = ? AND bos.group_id != ? AND bos.group_id IN (
         SELECT DISTINCT group_id FROM bookings
         WHERE date = ? AND status IN ('confirmed','tentative','blocked','held')
       )`,
    )
    .bind(optionId, exclude, date)
    .first<{ q: number }>();
  return (perBooking?.q ?? 0) + (perGroup?.q ?? 0);
}

export interface CancelPolicyRow {
  space_id: string | null;
  days_before: number;
  charge_pct: number;
  cutoff_time: string | null;
}

export async function getCancelPolicies(db: D1Database): Promise<CancelPolicyRow[]> {
  const { results } = await db
    .prepare('SELECT space_id, days_before, charge_pct, cutoff_time FROM cancel_policies ORDER BY sort_order')
    .all<CancelPolicyRow>();
  return results ?? [];
}

/** 顧客の指定年月(YYYY-MM)のセルフキャンセル回数 */
export async function getMonthlyCancelCount(
  db: D1Database,
  customerId: string,
  yearMonth: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM cancellation_log
       WHERE customer_id = ? AND substr(cancelled_at, 1, 7) = ?`,
    )
    .bind(customerId, yearMonth)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
