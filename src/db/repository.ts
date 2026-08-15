/**
 * D1 データアクセス層（Phase 1 で使う分）
 */
import type { HolidayType } from '../lib/calendar';
import { nowJST } from '../lib/clock';

/** spaces テーブルの行 */
export interface SpaceRow {
  id: string;
  name: string;
  name_en: string | null;
  slug: string | null;
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
  allow_card: number;
  allow_paypal: number;
  allow_invoice: number;
}

/** スペース作成/更新の入力 */
export interface SpaceInput {
  name: string;
  nameEn?: string | null;
  slug?: string | null;
  googleCalendarId?: string | null;
  billingType: 'hourly' | 'block';
  weekdayRate: number | null;
  weekendRate: number | null;
  dayRateHours: number | null;
  weekdayAvailable: boolean;
  weekendAvailable: boolean;
  slotMinutes: number;
  hasMinimum: boolean;
  minHours: number;
  openTime: string;
  closeTime: string;
  bookingHorizonDays: number;
  bookingDeadlineDays: number | null;
  blockName?: string | null;
  sortOrder: number;
  isActive: boolean;
  allowCard: boolean;
  allowPaypal: boolean;
  allowInvoice: boolean;
}

/** 全スペース（非公開含む・管理用） */
export async function getAllSpaces(db: D1Database): Promise<SpaceRow[]> {
  const { results } = await db.prepare('SELECT * FROM spaces ORDER BY sort_order').all<SpaceRow>();
  return results ?? [];
}

/** slug または id でスペースを取得（ディープリンク解決用） */
export async function getSpaceBySlugOrId(db: D1Database, key: string): Promise<SpaceRow | null> {
  return db
    .prepare('SELECT * FROM spaces WHERE slug = ? OR id = ? LIMIT 1')
    .bind(key, key)
    .first<SpaceRow>();
}

function bindSpace(s: SpaceInput): unknown[] {
  return [
    s.name,
    s.nameEn ?? null,
    s.slug ?? null,
    s.googleCalendarId ?? null,
    s.billingType,
    s.weekdayRate,
    s.weekendRate,
    s.dayRateHours,
    s.weekdayAvailable ? 1 : 0,
    s.weekendAvailable ? 1 : 0,
    s.slotMinutes,
    s.hasMinimum ? 1 : 0,
    s.minHours,
    s.openTime,
    s.closeTime,
    s.bookingHorizonDays,
    s.bookingDeadlineDays,
    s.blockName ?? null,
    s.sortOrder,
    s.isActive ? 1 : 0,
    s.allowCard ? 1 : 0,
    s.allowPaypal ? 1 : 0,
    s.allowInvoice ? 1 : 0,
  ];
}

export async function insertSpace(db: D1Database, id: string, s: SpaceInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO spaces
       (id, name, name_en, slug, google_calendar_id, billing_type, weekday_rate, weekend_rate, day_rate_hours,
        weekday_available, weekend_available, slot_minutes, has_minimum, min_hours,
        open_time, close_time, booking_horizon_days, booking_deadline_days, block_name, sort_order, is_active,
        allow_card, allow_paypal, allow_invoice)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, ...bindSpace(s))
    .run();
}

export async function updateSpace(db: D1Database, id: string, s: SpaceInput): Promise<void> {
  await db
    .prepare(
      `UPDATE spaces SET
        name = ?, name_en = ?, slug = ?, google_calendar_id = ?, billing_type = ?, weekday_rate = ?, weekend_rate = ?, day_rate_hours = ?,
        weekday_available = ?, weekend_available = ?, slot_minutes = ?, has_minimum = ?, min_hours = ?,
        open_time = ?, close_time = ?, booking_horizon_days = ?, booking_deadline_days = ?, block_name = ?, sort_order = ?, is_active = ?,
        allow_card = ?, allow_paypal = ?, allow_invoice = ?
       WHERE id = ?`,
    )
    .bind(...bindSpace(s), id)
    .run();
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
  name: string;
  start_date: string;
  end_date: string;
  surcharge_pct: number;
}

export async function getActiveSeasonalRules(db: D1Database): Promise<SeasonalRuleRow[]> {
  const { results } = await db
    .prepare('SELECT name, start_date, end_date, surcharge_pct FROM seasonal_pricing WHERE is_active = 1')
    .all<SeasonalRuleRow>();
  return results ?? [];
}

/**
 * 指定スペースに適用される有効な季節料金を返す。
 * 対象スペースの紐付けが無い季節料金は全スペース対象として含める。
 */
export async function getActiveSeasonalRulesForSpace(
  db: D1Database,
  spaceId: string,
): Promise<SeasonalRuleRow[]> {
  const { results } = await db
    .prepare(
      `SELECT sp.name, sp.start_date, sp.end_date, sp.surcharge_pct
       FROM seasonal_pricing sp
       WHERE sp.is_active = 1
         AND (
           NOT EXISTS (SELECT 1 FROM seasonal_spaces ss WHERE ss.seasonal_id = sp.id)
           OR EXISTS (SELECT 1 FROM seasonal_spaces ss WHERE ss.seasonal_id = sp.id AND ss.space_id = ?)
         )`,
    )
    .bind(spaceId)
    .all<SeasonalRuleRow>();
  return results ?? [];
}

// --- 季節料金（管理） ---
export interface SeasonalFullRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  surcharge_pct: number;
  is_active: number;
}

export async function getSeasonalAll(
  db: D1Database,
): Promise<Array<SeasonalFullRow & { space_ids: string[] }>> {
  const [{ results }, links] = await Promise.all([
    db
      .prepare('SELECT id, name, start_date, end_date, surcharge_pct, is_active FROM seasonal_pricing ORDER BY start_date')
      .all<SeasonalFullRow>(),
    db.prepare('SELECT seasonal_id, space_id FROM seasonal_spaces').all<{ seasonal_id: string; space_id: string }>(),
  ]);
  const bySeasonal = new Map<string, string[]>();
  for (const l of links.results ?? []) {
    const arr = bySeasonal.get(l.seasonal_id) ?? [];
    arr.push(l.space_id);
    bySeasonal.set(l.seasonal_id, arr);
  }
  return (results ?? []).map((r) => ({ ...r, space_ids: bySeasonal.get(r.id) ?? [] }));
}

export interface SeasonalInput {
  name: string;
  startDate: string;
  endDate: string;
  surchargePct: number;
  isActive: boolean;
  spaceIds: string[]; // 空配列 = 全スペース対象
}

async function setSeasonalSpaces(db: D1Database, seasonalId: string, spaceIds: string[]): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM seasonal_spaces WHERE seasonal_id = ?').bind(seasonalId),
  ];
  for (const sid of spaceIds) {
    stmts.push(db.prepare('INSERT OR IGNORE INTO seasonal_spaces (seasonal_id, space_id) VALUES (?, ?)').bind(seasonalId, sid));
  }
  await db.batch(stmts);
}

export async function insertSeasonal(db: D1Database, s: SeasonalInput): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO seasonal_pricing (id, name, start_date, end_date, surcharge_pct, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, s.name, s.startDate, s.endDate, s.surchargePct, s.isActive ? 1 : 0)
    .run();
  await setSeasonalSpaces(db, id, s.spaceIds);
  return id;
}

export async function updateSeasonal(db: D1Database, id: string, s: SeasonalInput): Promise<void> {
  await db
    .prepare(
      `UPDATE seasonal_pricing SET name = ?, start_date = ?, end_date = ?, surcharge_pct = ?, is_active = ? WHERE id = ?`,
    )
    .bind(s.name, s.startDate, s.endDate, s.surchargePct, s.isActive ? 1 : 0, id)
    .run();
  await setSeasonalSpaces(db, id, s.spaceIds);
}

export async function deleteSeasonal(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM seasonal_spaces WHERE seasonal_id = ?').bind(id),
    db.prepare('DELETE FROM seasonal_pricing WHERE id = ?').bind(id),
  ]);
}

// --- キャンペーン（管理・適用） ---
export interface CampaignRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  apply_weekday: number;
  apply_weekend: number;
  space_id: string | null;
  is_active: number;
}

export async function getCampaignsAll(db: D1Database): Promise<Array<CampaignRow & { space_name?: string }>> {
  const { results } = await db
    .prepare(
      `SELECT cp.id, cp.name, cp.start_date, cp.end_date, cp.discount_type, cp.discount_value,
              cp.apply_weekday, cp.apply_weekend, cp.space_id, cp.is_active, s.name AS space_name
       FROM campaigns cp LEFT JOIN spaces s ON s.id = cp.space_id
       ORDER BY cp.start_date`,
    )
    .all<CampaignRow & { space_name?: string }>();
  return results ?? [];
}

/** 有効なキャンペーン（適用判定用） */
export async function getActiveCampaigns(db: D1Database): Promise<CampaignRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, start_date, end_date, discount_type, discount_value,
              apply_weekday, apply_weekend, space_id, is_active
       FROM campaigns WHERE is_active = 1`,
    )
    .all<CampaignRow>();
  return results ?? [];
}

export interface CampaignInput {
  name: string;
  startDate: string;
  endDate: string;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  applyWeekday: boolean;
  applyWeekend: boolean;
  spaceId: string | null;
  isActive: boolean;
}

export async function insertCampaign(db: D1Database, cp: CampaignInput): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO campaigns (id, name, start_date, end_date, discount_type, discount_value, apply_weekday, apply_weekend, space_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, cp.name, cp.startDate, cp.endDate, cp.discountType, cp.discountValue, cp.applyWeekday ? 1 : 0, cp.applyWeekend ? 1 : 0, cp.spaceId, cp.isActive ? 1 : 0)
    .run();
  return id;
}

export async function updateCampaign(db: D1Database, id: string, cp: CampaignInput): Promise<void> {
  await db
    .prepare(
      `UPDATE campaigns SET name = ?, start_date = ?, end_date = ?, discount_type = ?, discount_value = ?,
              apply_weekday = ?, apply_weekend = ?, space_id = ?, is_active = ? WHERE id = ?`,
    )
    .bind(cp.name, cp.startDate, cp.endDate, cp.discountType, cp.discountValue, cp.applyWeekday ? 1 : 0, cp.applyWeekend ? 1 : 0, cp.spaceId, cp.isActive ? 1 : 0, id)
    .run();
}

export async function deleteCampaign(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM campaigns WHERE id = ?').bind(id).run();
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

/** 単一の system_setting を取得（未設定なら null） */
export async function getSystemSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM system_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row ? row.value : null;
}

/** system_setting を upsert */
export async function setSystemSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
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

/** 会員の全セッションを無効化（パスワード再設定時など） */
export async function deleteSessionsForCustomer(db: D1Database, customerId: string): Promise<void> {
  await db.prepare('DELETE FROM auth_sessions WHERE customer_id = ?').bind(customerId).run();
}

// --- パスワード再設定（#21） ---
export interface PasswordResetRow {
  token: string;
  customer_id: string;
  expires_at: string;
  used: number;
}

export async function createPasswordResetToken(
  db: D1Database,
  token: string,
  customerId: string,
  expiresAt: string,
  now: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO password_reset_tokens (token, customer_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)')
    .bind(token, customerId, expiresAt, now)
    .run();
}

export async function getPasswordResetToken(db: D1Database, token: string): Promise<PasswordResetRow | null> {
  return db
    .prepare('SELECT token, customer_id, expires_at, used FROM password_reset_tokens WHERE token = ?')
    .bind(token)
    .first<PasswordResetRow>();
}

/** パスワードを更新し、その顧客の再設定トークンを全て使用済みにする（未使用リンクも無効化） */
export async function applyPasswordReset(
  db: D1Database,
  customerId: string,
  passwordHash: string,
): Promise<void> {
  await db.batch([
    db.prepare('UPDATE customers SET password_hash = ?, is_registered = 1 WHERE id = ?').bind(passwordHash, customerId),
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE customer_id = ?').bind(customerId),
    db.prepare('DELETE FROM auth_sessions WHERE customer_id = ?').bind(customerId),
  ]);
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

export async function getPointBalance(db: D1Database, customerId: string): Promise<number> {
  const row = await db
    .prepare('SELECT point_balance FROM customers WHERE id = ?')
    .bind(customerId)
    .first<{ point_balance: number }>();
  return row?.point_balance ?? 0;
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

// --- 割引クーポン ---
export interface CouponRow {
  id: string;
  customer_id: string;
  name: string;
  code: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  total_hours: number;
  remaining_hours: number;
  valid_from: string;
  valid_until: string | null; // null = 無期限
  status: string;
}

/** コードで顧客のクーポンを取得（本人限定） */
export async function getCouponByCodeForCustomer(
  db: D1Database,
  code: string,
  customerId: string,
): Promise<CouponRow | null> {
  return db
    .prepare('SELECT * FROM discount_coupons WHERE code = ? AND customer_id = ?')
    .bind(code, customerId)
    .first<CouponRow>();
}

/** クーポン対象スペースID一覧 */
export async function getCouponSpaceIds(db: D1Database, couponId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT space_id FROM coupon_spaces WHERE coupon_id = ?')
    .bind(couponId)
    .all<{ space_id: string }>();
  return (results ?? []).map((r) => r.space_id);
}

/** 会員の保有クーポン一覧（マイページ） */
export async function getMemberCoupons(db: D1Database, customerId: string) {
  const { results } = await db
    .prepare(
      `SELECT dc.code, dc.name, dc.discount_type, dc.discount_value, dc.total_hours, dc.remaining_hours,
              dc.valid_from, dc.valid_until, dc.status,
              (SELECT GROUP_CONCAT(s.name, ' / ') FROM coupon_spaces cs JOIN spaces s ON s.id = cs.space_id WHERE cs.coupon_id = dc.id) AS spaces
       FROM discount_coupons dc WHERE dc.customer_id = ? ORDER BY dc.created_at DESC`,
    )
    .bind(customerId)
    .all();
  return results ?? [];
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

// --- 顧客管理・特典（管理者用） ---
export async function searchCustomers(db: D1Database, q: string) {
  const like = `%${q}%`;
  const { results } = await db
    .prepare(
      `SELECT id, email, contact_name, company_name, phone, status_id, point_balance, is_registered, is_blocked
       FROM customers
       WHERE (?1 = '' OR email LIKE ?2 OR contact_name LIKE ?2 OR phone LIKE ?2 OR company_name LIKE ?2)
       ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(q, like)
    .all();
  return results ?? [];
}

/** 新規顧客を作成（管理画面から手動登録。ゲスト扱い） */
export async function createCustomer(
  db: D1Database,
  params: { email: string | null; contactName: string; phone: string | null; companyName: string | null },
  now: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO customers (id, email, is_registered, company_name, contact_name, phone, status_id, created_at)
       VALUES (?, ?, 0, ?, ?, ?, 'general', ?)`,
    )
    .bind(id, params.email, params.companyName, params.contactName, params.phone, now)
    .run();
  return id;
}

/** クーポンコードの重複確認（全体でユニーク） */
export async function couponCodeExists(db: D1Database, code: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM discount_coupons WHERE code = ? LIMIT 1').bind(code).first();
  return row != null;
}

/** クーポン発行（顧客に紐付け、対象スペースも設定） */
export async function issueCoupon(
  db: D1Database,
  coupon: {
    customerId: string;
    name: string;
    code: string;
    discountType: 'percent' | 'fixed';
    discountValue: number;
    totalHours: number;
    validFrom: string;
    validUntil: string | null; // null = 無期限
    staffMemo: string | null;
    spaceIds: string[];
  },
  createdBy: string,
  now: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO discount_coupons
         (id, customer_id, name, code, discount_type, discount_value, total_hours, remaining_hours, apply_to, valid_from, valid_until, staff_memo, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'space_only', ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(
        id, coupon.customerId, coupon.name, coupon.code, coupon.discountType, coupon.discountValue,
        coupon.totalHours, coupon.totalHours, coupon.validFrom, coupon.validUntil, coupon.staffMemo, createdBy, now,
      ),
  ];
  for (const sid of coupon.spaceIds) {
    stmts.push(db.prepare('INSERT OR REPLACE INTO coupon_spaces (coupon_id, space_id) VALUES (?, ?)').bind(id, sid));
  }
  await db.batch(stmts);
  return id;
}

/** ポイント手動付与/取消（残高更新 + 履歴記録） */
export async function adjustPoints(
  db: D1Database,
  customerId: string,
  params: { amount: number; type: 'add' | 'remove'; description: string | null },
  createdBy: string,
  now: string,
): Promise<{ balanceAfter: number }> {
  const current = await getPointBalance(db, customerId);
  const delta = params.type === 'add' ? params.amount : -params.amount;
  const balanceAfter = Math.max(0, current + delta);
  const logType = params.type === 'add' ? 'manual_add' : 'manual_remove';
  await db.batch([
    db.prepare('UPDATE customers SET point_balance = ? WHERE id = ?').bind(balanceAfter, customerId),
    db
      .prepare(
        `INSERT INTO point_log (id, customer_id, type, amount, balance_after, description, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), customerId, logType, params.amount, balanceAfter, params.description, createdBy, now),
  ]);
  return { balanceAfter };
}

// --- 管理者 ---
export interface AdminAuthRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: string;
  is_active: number;
}

export async function countAdmins(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM admin_users').first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertAdmin(
  db: D1Database,
  admin: { id: string; email: string; passwordHash: string; name: string; role: string },
): Promise<void> {
  await db
    .prepare('INSERT INTO admin_users (id, email, password_hash, name, role, is_active) VALUES (?, ?, ?, ?, ?, 1)')
    .bind(admin.id, admin.email, admin.passwordHash, admin.name, admin.role)
    .run();
}

export async function getAdminAuthByEmail(db: D1Database, email: string): Promise<AdminAuthRow | null> {
  return db
    .prepare('SELECT id, email, password_hash, name, role, is_active FROM admin_users WHERE email = ?')
    .bind(email)
    .first<AdminAuthRow>();
}

export async function createAdminSession(
  db: D1Database,
  token: string,
  adminId: string,
  expiresAt: string,
  now: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO admin_sessions (token, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(token, adminId, expiresAt, now)
    .run();
}

export interface AdminSessionRow {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: number;
  expires_at: string;
}

export async function getAdminSession(db: D1Database, token: string): Promise<AdminSessionRow | null> {
  return db
    .prepare(
      `SELECT a.id, a.email, a.name, a.role, a.is_active, s.expires_at
       FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id WHERE s.token = ?`,
    )
    .bind(token)
    .first<AdminSessionRow>();
}

export async function deleteAdminSession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(token).run();
}

/** 管理者向け予約一覧（フィルタ: 期間・スペース・ステータス） */
export async function listBookingsForAdmin(
  db: D1Database,
  filters: { from?: string; to?: string; spaceId?: string; status?: string; view?: 'active' | 'archive' },
) {
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (filters.from) {
    conds.push('b.date >= ?');
    binds.push(filters.from);
  }
  if (filters.to) {
    conds.push('b.date <= ?');
    binds.push(filters.to);
  }
  if (filters.spaceId) {
    conds.push('b.space_id = ?');
    binds.push(filters.spaceId);
  }
  if (filters.status) {
    // 明示的なステータス指定が最優先（後方互換）
    conds.push('b.status = ?');
    binds.push(filters.status);
  } else if (filters.view === 'archive') {
    // アーカイブ（キャンセル済み）のみ
    conds.push("b.status = 'cancelled'");
  } else if (filters.view === 'active') {
    // アクティブ（初期表示）：キャンセル済みは除外
    conds.push("b.status != 'cancelled'");
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const { results } = await db
    .prepare(
      `SELECT b.date, b.start_time, b.end_time, b.status, b.price, b.billing_mode,
              bg.booking_number, bg.event_name, bg.source, s.name AS space_name, b.space_id,
              bg.payment_method, bg.payment_status,
              c.contact_name, c.company_name
       FROM bookings b
       JOIN booking_groups bg ON bg.id = b.group_id
       LEFT JOIN spaces s ON s.id = b.space_id
       LEFT JOIN customers c ON c.id = bg.customer_id
       ${where}
       ORDER BY b.date, b.start_time`,
    )
    .bind(...binds)
    .all();
  return results ?? [];
}

// --- カレンダー管理（休業日・祝日） ---
export interface HolidayRow {
  id: string;
  date: string;
  name: string | null;
  type: HolidayType;
}

export async function getHolidaysAll(db: D1Database, from?: string, to?: string): Promise<HolidayRow[]> {
  let sql = 'SELECT id, date, name, type FROM calendar_holidays';
  const binds: unknown[] = [];
  if (from && to) {
    sql += ' WHERE date >= ? AND date <= ?';
    binds.push(from, to);
  }
  sql += ' ORDER BY date';
  const { results } = await db.prepare(sql).bind(...binds).all<HolidayRow>();
  return results ?? [];
}

export async function upsertHoliday(
  db: D1Database,
  h: { date: string; name: string | null; type: HolidayType },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO calendar_holidays (id, date, name, type) VALUES (?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET name = excluded.name, type = excluded.type`,
    )
    .bind(crypto.randomUUID(), h.date, h.name, h.type)
    .run();
}

export async function deleteHoliday(db: D1Database, date: string): Promise<void> {
  await db.prepare('DELETE FROM calendar_holidays WHERE date = ?').bind(date).run();
}

export interface ClosureRow {
  id: string;
  space_id: string;
  date: string;
  reason: string | null;
}

export async function getClosuresAll(db: D1Database, spaceId?: string): Promise<Array<ClosureRow & { space_name?: string }>> {
  let sql =
    `SELECT sc.id, sc.space_id, sc.date, sc.reason, s.name AS space_name
     FROM space_closures sc LEFT JOIN spaces s ON s.id = sc.space_id`;
  const binds: unknown[] = [];
  if (spaceId) { sql += ' WHERE sc.space_id = ?'; binds.push(spaceId); }
  sql += ' ORDER BY sc.date';
  const { results } = await db.prepare(sql).bind(...binds).all<ClosureRow & { space_name?: string }>();
  return results ?? [];
}

export async function insertClosure(
  db: D1Database,
  c: { spaceId: string; date: string; reason: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO space_closures (id, space_id, date, reason) VALUES (?, ?, ?, ?)
       ON CONFLICT(space_id, date) DO UPDATE SET reason = excluded.reason`,
    )
    .bind(crypto.randomUUID(), c.spaceId, c.date, c.reason)
    .run();
}

export async function deleteClosure(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM space_closures WHERE id = ?').bind(id).run();
}

// --- サイネージ ---
export async function verifySignageToken(
  db: D1Database,
  spaceId: string,
  token: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM signage_tokens WHERE space_id = ? AND token = ?')
    .bind(spaceId, token)
    .first<{ ok: number }>();
  return !!row;
}

export interface SignageBookingRow {
  start_time: string;
  end_time: string;
  event_name: string;
}

/** サイネージ用: 指定日の確定予約（イベント名付き）を時刻順で */
export async function getSignageBookings(
  db: D1Database,
  spaceId: string,
  date: string,
): Promise<SignageBookingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT b.start_time, b.end_time, bg.event_name
       FROM bookings b JOIN booking_groups bg ON bg.id = b.group_id
       WHERE b.space_id = ? AND b.date = ? AND b.status = 'confirmed'
       ORDER BY b.start_time`,
    )
    .bind(spaceId, date)
    .all<SignageBookingRow>();
  return results ?? [];
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
  payment_method: string | null;
  invoice_name: string | null;
  payment_status: string;
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
  google_event_id: string | null;
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

/** 全オプション（非公開含む・管理用） */
export async function getAllOptions(db: D1Database): Promise<OptionRow[]> {
  const { results } = await db.prepare('SELECT * FROM options ORDER BY sort_order').all<OptionRow>();
  return results ?? [];
}

/** 全 space_options リンク（option_id → space_id[] のマップ構築用） */
export async function getAllOptionSpaceLinks(db: D1Database): Promise<Array<{ option_id: string; space_id: string }>> {
  const { results } = await db
    .prepare('SELECT option_id, space_id FROM space_options WHERE is_active = 1')
    .all<{ option_id: string; space_id: string }>();
  return results ?? [];
}

export interface OptionInput {
  name: string;
  category: string;
  type: 'toggle' | 'quantity';
  priceType: 'free' | 'fixed' | 'per_unit';
  unitPrice: number;
  unitLabel: string | null;
  maxQty: number | null;
  stockTotal: number | null;
  scope: 'per_booking' | 'per_group';
  sortOrder: number;
  isActive: boolean;
}

function bindOption(o: OptionInput): unknown[] {
  return [
    o.name, o.category, o.type, o.priceType, o.unitPrice, o.unitLabel ?? null,
    o.maxQty, o.stockTotal, o.scope, o.sortOrder, o.isActive ? 1 : 0,
  ];
}

export async function insertOption(db: D1Database, id: string, o: OptionInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO options (id, name, category, type, price_type, unit_price, unit_label, max_qty, stock_total, scope, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, ...bindOption(o))
    .run();
}

export async function updateOption(db: D1Database, id: string, o: OptionInput): Promise<void> {
  await db
    .prepare(
      `UPDATE options SET name=?, category=?, type=?, price_type=?, unit_price=?, unit_label=?, max_qty=?, stock_total=?, scope=?, sort_order=?, is_active=?
       WHERE id = ?`,
    )
    .bind(...bindOption(o), id)
    .run();
}

/** オプションの対象スペースを置き換える */
export async function setOptionSpaces(db: D1Database, optionId: string, spaceIds: string[]): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM space_options WHERE option_id = ?').bind(optionId),
  ];
  for (const sid of spaceIds) {
    stmts.push(
      db.prepare('INSERT OR REPLACE INTO space_options (space_id, option_id, is_active) VALUES (?, ?, 1)').bind(sid, optionId),
    );
  }
  await db.batch(stmts);
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

// --- スペース別の追加質問（#22） ---
export interface SpaceQuestionRow {
  id: string;
  space_id: string;
  label: string;
  input_type: 'text' | 'select';
  options: string | null; // JSON配列文字列
  required: number;
  sort_order: number;
  is_active: number;
}

export interface SpaceQuestionInput {
  spaceId: string;
  label: string;
  inputType: 'text' | 'select';
  options: string[] | null;
  required: boolean;
  sortOrder: number;
  isActive: boolean;
}

/** スペースの有効な追加質問（並び順） */
export async function getSpaceQuestions(db: D1Database, spaceId: string): Promise<SpaceQuestionRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM space_questions WHERE space_id = ? AND is_active = 1 ORDER BY sort_order, created_at')
    .bind(spaceId)
    .all<SpaceQuestionRow>();
  return results ?? [];
}

/** 管理用：スペースの全追加質問（無効含む） */
export async function getSpaceQuestionsAdmin(db: D1Database, spaceId: string): Promise<SpaceQuestionRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM space_questions WHERE space_id = ? ORDER BY sort_order, created_at')
    .bind(spaceId)
    .all<SpaceQuestionRow>();
  return results ?? [];
}

export async function getSpaceQuestionById(db: D1Database, id: string): Promise<SpaceQuestionRow | null> {
  return db.prepare('SELECT * FROM space_questions WHERE id = ?').bind(id).first<SpaceQuestionRow>();
}

export async function insertSpaceQuestion(db: D1Database, q: SpaceQuestionInput): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO space_questions (id, space_id, label, input_type, options, required, sort_order, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, q.spaceId, q.label, q.inputType, q.options ? JSON.stringify(q.options) : null, q.required ? 1 : 0, q.sortOrder, q.isActive ? 1 : 0, nowJST())
    .run();
  return id;
}

export async function updateSpaceQuestion(db: D1Database, id: string, q: SpaceQuestionInput): Promise<void> {
  await db
    .prepare(
      `UPDATE space_questions SET label = ?, input_type = ?, options = ?, required = ?, sort_order = ?, is_active = ? WHERE id = ?`,
    )
    .bind(q.label, q.inputType, q.options ? JSON.stringify(q.options) : null, q.required ? 1 : 0, q.sortOrder, q.isActive ? 1 : 0, id)
    .run();
}

export async function deleteSpaceQuestion(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM space_questions WHERE id = ?').bind(id).run();
}

/** 予約グループの回答を取得（質問文＋回答） */
export async function getBookingAnswers(db: D1Database, groupId: string): Promise<Array<{ label: string; answer: string | null }>> {
  const { results } = await db
    .prepare('SELECT label, answer FROM booking_answers WHERE group_id = ? ORDER BY created_at')
    .bind(groupId)
    .all<{ label: string; answer: string | null }>();
  return results ?? [];
}

/** 予約グループの回答をまとめて保存（作成時） */
export async function insertBookingAnswers(
  db: D1Database,
  groupId: string,
  rows: ReadonlyArray<{ questionId: string; label: string; answer: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  const now = nowJST();
  await db.batch(
    rows.map((r) =>
      db
        .prepare('INSERT INTO booking_answers (id, group_id, question_id, label, answer, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), groupId, r.questionId, r.label, r.answer, now),
    ),
  );
}

// --- チケット（回数券）#24 ---
export interface TicketRow {
  id: string;
  customer_id: string;
  name: string;
  total_hours: number;
  remaining_hours: number;
  valid_from: string;
  valid_until: string;
  status: string;
}

/** 管理者がチケットを発行して顧客に紐付ける */
export async function issueTicket(
  db: D1Database,
  t: { customerId: string; name: string; totalHours: number; validFrom: string; validUntil: string; spaceIds: string[]; productId?: string | null },
  now: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO tickets (id, customer_id, product_id, name, total_hours, remaining_hours, valid_from, valid_until, status, purchased_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
    .bind(id, t.customerId, t.productId ?? null, t.name, t.totalHours, t.totalHours, t.validFrom, t.validUntil, now)
    .run();
  if (t.spaceIds.length) {
    await db.batch(
      t.spaceIds.map((sid) => db.prepare('INSERT OR IGNORE INTO ticket_spaces (ticket_id, space_id) VALUES (?, ?)').bind(id, sid)),
    );
  }
  return id;
}

/** 発行済みチケットの残時間・総時間・有効期限・状態を任意に変更（サービス追加や訂正用）#24 */
export async function updateIssuedTicket(
  db: D1Database,
  ticketId: string,
  patch: { totalHours?: number; remainingHours?: number; validUntil?: string; status?: string },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.totalHours != null) { sets.push('total_hours = ?'); vals.push(patch.totalHours); }
  if (patch.remainingHours != null) { sets.push('remaining_hours = ?'); vals.push(patch.remainingHours); }
  if (patch.validUntil) { sets.push('valid_until = ?'); vals.push(patch.validUntil); }
  if (patch.status) { sets.push('status = ?'); vals.push(patch.status); }
  if (!sets.length) return;
  vals.push(ticketId);
  await db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}

export async function getIssuedTicket(db: D1Database, ticketId: string) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').bind(ticketId).first();
}

// ---------------------------------------------------------------------------
// チケット商品マスタ（販売中のチケット）#24
// ---------------------------------------------------------------------------
export interface TicketProductInput {
  name: string;
  totalHours: number;
  price: number;
  validityDays: number;
  isActive: boolean;
  sortOrder: number;
}

/** チケット商品一覧（管理用：全件、対象スペースID配列付き） */
export async function getTicketProducts(db: D1Database, activeOnly = false) {
  const where = activeOnly ? 'WHERE p.is_active = 1' : '';
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.total_hours, p.price, p.validity_days, p.is_active, p.sort_order
       FROM ticket_products p ${where} ORDER BY p.sort_order, p.price`,
    )
    .all<{ id: string; name: string; total_hours: number; price: number; validity_days: number; is_active: number; sort_order: number }>();
  const products = results ?? [];
  if (!products.length) return [];
  const { results: links } = await db
    .prepare('SELECT product_id, space_id FROM ticket_product_spaces')
    .all<{ product_id: string; space_id: string }>();
  const byProduct = new Map<string, string[]>();
  for (const l of links ?? []) {
    if (!byProduct.has(l.product_id)) byProduct.set(l.product_id, []);
    byProduct.get(l.product_id)!.push(l.space_id);
  }
  return products.map((p) => ({ ...p, space_ids: byProduct.get(p.id) ?? [] }));
}

/** 指定スペースで販売中のチケット商品（顧客向け：追加購入案内用） */
export async function getTicketProductsForSpace(db: D1Database, spaceId: string) {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.total_hours, p.price, p.validity_days
       FROM ticket_products p
       JOIN ticket_product_spaces ps ON ps.product_id = p.id
       WHERE ps.space_id = ? AND p.is_active = 1
       ORDER BY p.sort_order, p.price`,
    )
    .bind(spaceId)
    .all();
  return results ?? [];
}

export async function getTicketProduct(db: D1Database, id: string) {
  const p = await db.prepare('SELECT * FROM ticket_products WHERE id = ?').bind(id).first();
  if (!p) return null;
  const { results } = await db.prepare('SELECT space_id FROM ticket_product_spaces WHERE product_id = ?').bind(id).all<{ space_id: string }>();
  return { ...p, space_ids: (results ?? []).map((r) => r.space_id) };
}

export async function insertTicketProduct(db: D1Database, input: TicketProductInput, spaceIds: string[]): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO ticket_products (id, name, total_hours, price, validity_days, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.name, input.totalHours, input.price, input.validityDays, input.isActive ? 1 : 0, input.sortOrder)
    .run();
  if (spaceIds.length) {
    await db.batch(spaceIds.map((sid) => db.prepare('INSERT OR IGNORE INTO ticket_product_spaces (product_id, space_id) VALUES (?, ?)').bind(id, sid)));
  }
  return id;
}

export async function updateTicketProduct(db: D1Database, id: string, input: TicketProductInput, spaceIds: string[]): Promise<void> {
  await db
    .prepare(
      `UPDATE ticket_products SET name = ?, total_hours = ?, price = ?, validity_days = ?, is_active = ?, sort_order = ? WHERE id = ?`,
    )
    .bind(input.name, input.totalHours, input.price, input.validityDays, input.isActive ? 1 : 0, input.sortOrder, id)
    .run();
  await db.prepare('DELETE FROM ticket_product_spaces WHERE product_id = ?').bind(id).run();
  if (spaceIds.length) {
    await db.batch(spaceIds.map((sid) => db.prepare('INSERT OR IGNORE INTO ticket_product_spaces (product_id, space_id) VALUES (?, ?)').bind(id, sid)));
  }
}

// ---------------------------------------------------------------------------
// チケットのオンライン購入（Stripe Checkout）#24
// ---------------------------------------------------------------------------
/** 決済開始時に purchases 行を pending で作成 */
export async function createPendingPurchase(
  db: D1Database,
  p: { id: string; customerId: string; productId: string; amount: number; sessionId: string },
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ticket_purchases (id, customer_id, product_id, stripe_session_id, amount, currency, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'jpy', 'pending', ?)`,
    )
    .bind(p.id, p.customerId, p.productId, p.sessionId, p.amount, now)
    .run();
}

export async function getPurchaseBySession(db: D1Database, sessionId: string) {
  return db.prepare('SELECT * FROM ticket_purchases WHERE stripe_session_id = ?').bind(sessionId).first<{
    id: string;
    customer_id: string;
    product_id: string | null;
    status: string;
    ticket_id: string | null;
  }>();
}

/**
 * 決済完了 Webhook を受けてチケットを発行（冪等）。
 * 'pending'→'processing' を条件付き UPDATE で 1回だけ確保し、二重発行を防ぐ。
 * addDaysISO は clock.addDaysJST 相当（有効期限計算）を注入する。
 */
export async function fulfillTicketPurchase(
  db: D1Database,
  sessionId: string,
  now: string,
  today: string,
  addDaysISO: (dateISO: string, days: number) => string,
): Promise<{
  ok: boolean;
  already?: boolean;
  ticketId?: string;
  reason?: string;
  customerId?: string;
  productName?: string;
  totalHours?: number;
  validUntil?: string;
  amount?: number;
}> {
  const purchase = await getPurchaseBySession(db, sessionId);
  if (!purchase) return { ok: false, reason: 'purchase not found' };
  if (purchase.status === 'paid') return { ok: true, already: true, ticketId: purchase.ticket_id ?? undefined };

  // pending のときだけ processing に遷移して所有権を確保（同時配信の二重発行防止）
  const claim = await db
    .prepare("UPDATE ticket_purchases SET status = 'processing' WHERE stripe_session_id = ? AND status = 'pending'")
    .bind(sessionId)
    .run();
  const changed = (claim.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (changed !== 1) {
    // 既に他で処理中/処理済み
    const again = await getPurchaseBySession(db, sessionId);
    return { ok: true, already: true, ticketId: again?.ticket_id ?? undefined };
  }

  if (!purchase.product_id) {
    await db.prepare("UPDATE ticket_purchases SET status = 'pending' WHERE stripe_session_id = ?").bind(sessionId).run();
    return { ok: false, reason: 'no product' };
  }
  const product = (await getTicketProduct(db, purchase.product_id)) as
    | { name: string; total_hours: number; validity_days: number; space_ids: string[] }
    | null;
  if (!product) {
    await db.prepare("UPDATE ticket_purchases SET status = 'pending' WHERE stripe_session_id = ?").bind(sessionId).run();
    return { ok: false, reason: 'product missing' };
  }
  const validUntil = addDaysISO(today, product.validity_days);
  const ticketId = await issueTicket(
    db,
    {
      customerId: purchase.customer_id,
      name: product.name,
      totalHours: product.total_hours,
      validFrom: today,
      validUntil,
      spaceIds: product.space_ids,
      productId: purchase.product_id,
    },
    now,
  );
  await db
    .prepare("UPDATE ticket_purchases SET status = 'paid', ticket_id = ?, paid_at = ? WHERE stripe_session_id = ?")
    .bind(ticketId, now, sessionId)
    .run();
  return {
    ok: true,
    ticketId,
    customerId: purchase.customer_id,
    productName: product.name,
    totalHours: product.total_hours,
    validUntil,
    amount: (purchase as { amount?: number }).amount,
  };
}

// ---------------------------------------------------------------------------
// Googleカレンダー出力用のリッチ情報を集約取得
// ---------------------------------------------------------------------------

export interface BookingCalendarData {
  calendarId: string | null;
  bookingNumber: string;
  status: string;
  spaceName: string;
  customerName: string;
  phone: string | null;
  eventName: string;
  purpose: string | null;
  headcount: number | null;
  total: number;
  paymentStatus: string;
  paymentMethod: string | null;
  repeatCustomer: boolean;
  options: Array<{ name: string; quantity: number }>;
  rows: Array<{ id: string; date: string; start_time: string; end_time: string; google_event_id: string | null }>;
}

/** 予約グループのカレンダー出力に必要な情報を一括取得する */
export async function getBookingCalendarData(db: D1Database, groupId: string): Promise<BookingCalendarData | null> {
  const g = await db
    .prepare(
      `SELECT bg.booking_number, bg.status, bg.event_name, bg.total_amount, bg.payment_status, bg.payment_method,
              bg.purpose, bg.headcount, bg.customer_id, bg.space_id,
              s.name AS space_name, s.google_calendar_id,
              c.contact_name, c.phone
       FROM booking_groups bg
       LEFT JOIN spaces s ON s.id = bg.space_id
       LEFT JOIN customers c ON c.id = bg.customer_id
       WHERE bg.id = ?`,
    )
    .bind(groupId)
    .first<{
      booking_number: string;
      status: string;
      event_name: string;
      total_amount: number;
      payment_status: string;
      payment_method: string | null;
      purpose: string | null;
      headcount: number | null;
      customer_id: string | null;
      space_id: string;
      space_name: string | null;
      google_calendar_id: string | null;
      contact_name: string | null;
      phone: string | null;
    }>();
  if (!g) return null;

  const [{ results: rows }, { results: opts }] = await Promise.all([
    db
      .prepare('SELECT id, date, start_time, end_time, google_event_id FROM bookings WHERE group_id = ? ORDER BY date, start_time')
      .bind(groupId)
      .all<{ id: string; date: string; start_time: string; end_time: string; google_event_id: string | null }>(),
    db
      .prepare(
        `SELECT o.name AS name, SUM(bos.quantity) AS quantity
         FROM booking_option_selections bos JOIN options o ON o.id = bos.option_id
         WHERE bos.group_id = ? GROUP BY o.id, o.name`,
      )
      .bind(groupId)
      .all<{ name: string; quantity: number }>(),
  ]);

  // 利用実績（この予約以外に確定/完了の予約があれば「利用経験あり」）
  let repeatCustomer = false;
  if (g.customer_id) {
    const cnt = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM booking_groups WHERE customer_id = ? AND id <> ? AND status IN ('confirmed','completed')",
      )
      .bind(g.customer_id, groupId)
      .first<{ n: number }>();
    repeatCustomer = (cnt?.n ?? 0) > 0;
  }

  return {
    calendarId: g.google_calendar_id,
    bookingNumber: g.booking_number,
    status: g.status,
    spaceName: g.space_name ?? '',
    customerName: g.contact_name ?? 'お客様',
    phone: g.phone,
    eventName: g.event_name,
    purpose: g.purpose,
    headcount: g.headcount,
    total: g.total_amount,
    paymentStatus: g.payment_status,
    paymentMethod: g.payment_method,
    repeatCustomer,
    options: (opts ?? []).map((o) => ({ name: o.name, quantity: Number(o.quantity) })),
    rows: rows ?? [],
  };
}

// ---------------------------------------------------------------------------
// 予約のオンライン決済（Stripe/PayPal）#35
// ---------------------------------------------------------------------------
export async function createBookingPayment(
  db: D1Database,
  p: { id: string; groupId: string; provider: string; amount: number; sessionId: string },
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO booking_payments (id, group_id, provider, stripe_session_id, amount, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(p.id, p.groupId, p.provider, p.sessionId, p.amount, now)
    .run();
}

/** 決済完了ページ表示用の予約サマリ（予約番号・スペース・日時・金額・支払い方法）#35 */
export async function getBookingSummaryForGroup(db: D1Database, groupId: string) {
  const g = await db
    .prepare(
      `SELECT bg.booking_number, bg.total_amount, bg.payment_method, bg.event_name, s.name AS space_name
       FROM booking_groups bg LEFT JOIN spaces s ON s.id = bg.space_id WHERE bg.id = ?`,
    )
    .bind(groupId)
    .first<{ booking_number: string; total_amount: number; payment_method: string | null; event_name: string; space_name: string | null }>();
  if (!g) return null;
  const { results } = await db
    .prepare('SELECT date, start_time, end_time FROM bookings WHERE group_id = ? ORDER BY date, start_time')
    .bind(groupId)
    .all<{ date: string; start_time: string; end_time: string }>();
  return {
    bookingNumber: g.booking_number,
    spaceName: g.space_name ?? '',
    eventName: g.event_name,
    total: g.total_amount,
    paymentMethod: g.payment_method,
    items: (results ?? []).map((r) => ({ date: r.date, startTime: r.start_time, endTime: r.end_time })),
  };
}

export async function getBookingPaymentBySession(db: D1Database, sessionId: string) {
  return db.prepare('SELECT * FROM booking_payments WHERE stripe_session_id = ?').bind(sessionId).first<{
    id: string;
    group_id: string;
    status: string;
  }>();
}

/** 決済完了 Webhook を受けて予約を入金済みにする（冪等） */
export async function markBookingPaymentPaid(db: D1Database, sessionId: string, now: string): Promise<{ ok: boolean; groupId?: string; already?: boolean }> {
  const pay = await getBookingPaymentBySession(db, sessionId);
  if (!pay) return { ok: false };
  if (pay.status === 'paid') return { ok: true, already: true, groupId: pay.group_id };
  await db.batch([
    db.prepare("UPDATE booking_payments SET status = 'paid', paid_at = ? WHERE stripe_session_id = ?").bind(now, sessionId),
    db.prepare("UPDATE booking_groups SET payment_status = 'paid' WHERE id = ?").bind(pay.group_id),
  ]);
  return { ok: true, groupId: pay.group_id };
}

// ---------------------------------------------------------------------------
// 書類（請求書・領収書）#41
// ---------------------------------------------------------------------------

export interface IssuerSettings {
  name: string;
  zip?: string;
  address?: string;
  tel?: string;
  email?: string;
  invoiceRegNo?: string;
  bankInfo?: string;
  note?: string;
}

/** 事業者情報（請求書・領収書の発行元）を system_settings から取得 */
export async function getIssuerInfo(db: D1Database): Promise<IssuerSettings> {
  const s = await getSystemSettings(db);
  return {
    name: s.get('issuer_name') || 'レンタルスペースALBE',
    zip: s.get('issuer_zip') || '',
    address: s.get('issuer_address') || '',
    tel: s.get('issuer_tel') || '',
    email: s.get('issuer_email') || '',
    invoiceRegNo: s.get('issuer_invoice_reg_no') || '',
    bankInfo: s.get('issuer_bank_info') || '',
    note: s.get('issuer_note') || '',
  };
}

export interface DocumentRow {
  id: string;
  group_id: string;
  customer_id: string;
  type: 'invoice' | 'receipt';
  booking_number: string;
  public_token: string;
  total_amount: number;
  issued_at: string;
  status: string;
}

/** 推測不可能な書類トークンを生成（64桁hex） */
function newDocumentToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
}

/**
 * 予約グループに対して書類を発行（冪等）。
 * 既に同種の有効な書類があればそれを返し、新規発行しない。
 */
export async function createDocumentForGroup(
  db: D1Database,
  groupId: string,
  type: 'invoice' | 'receipt',
): Promise<{ token: string; created: boolean } | null> {
  const existing = await db
    .prepare("SELECT public_token FROM documents WHERE group_id = ? AND type = ? AND status = 'issued' LIMIT 1")
    .bind(groupId, type)
    .first<{ public_token: string }>();
  if (existing) return { token: existing.public_token, created: false };

  const g = await db
    .prepare('SELECT booking_number, customer_id, total_amount FROM booking_groups WHERE id = ?')
    .bind(groupId)
    .first<{ booking_number: string; customer_id: string; total_amount: number }>();
  if (!g) return null;

  const token = newDocumentToken();
  await db
    .prepare(
      `INSERT INTO documents (id, group_id, customer_id, type, booking_number, public_token, total_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), groupId, g.customer_id, type, g.booking_number, token, g.total_amount)
    .run();
  return { token, created: true };
}

export async function getDocumentByToken(db: D1Database, token: string): Promise<DocumentRow | null> {
  const row = await db
    .prepare("SELECT * FROM documents WHERE public_token = ? AND status = 'issued'")
    .bind(token)
    .first<DocumentRow>();
  return row ?? null;
}

/** 会員（顧客）の書類一覧（新しい順） */
export async function getDocumentsForCustomer(db: D1Database, customerId: string): Promise<DocumentRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM documents WHERE customer_id = ? AND status = 'issued' ORDER BY issued_at DESC")
    .bind(customerId)
    .all<DocumentRow>();
  return results ?? [];
}

/** 管理画面用：書類一覧（宛名付き・新しい順） */
export async function listDocumentsForAdmin(db: D1Database, limit = 200) {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.type, d.booking_number, d.public_token, d.total_amount, d.issued_at, d.status,
              c.contact_name, c.company_name, bg.invoice_name
       FROM documents d
       LEFT JOIN customers c ON c.id = d.customer_id
       LEFT JOIN booking_groups bg ON bg.id = d.group_id
       WHERE d.status = 'issued'
       ORDER BY d.issued_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// 未入金アラート（#41/#42）
// ---------------------------------------------------------------------------

export interface OverdueBookingRow {
  id: string;
  booking_number: string;
  total_amount: number;
  payment_method: string | null;
  created_at: string;
  space_name: string | null;
  contact_name: string | null;
  email: string | null;
  invoice_name: string | null;
}

/**
 * 予約確定日から一定日数を過ぎても未入金の予約を返す（Cron用）。
 * 対象: status='confirmed' かつ payment_status が未入金('unpaid')または請求書払い('invoice')、
 *       created_at の日付が cutoffDate 以前、まだアラート未送信。
 */
export async function getOverdueUnpaidBookings(db: D1Database, cutoffDate: string): Promise<OverdueBookingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT bg.id, bg.booking_number, bg.total_amount, bg.payment_method, bg.created_at,
              bg.invoice_name, s.name AS space_name, c.contact_name, c.email
       FROM booking_groups bg
       LEFT JOIN spaces s ON s.id = bg.space_id
       LEFT JOIN customers c ON c.id = bg.customer_id
       WHERE bg.status = 'confirmed'
         AND bg.payment_status IN ('unpaid', 'invoice')
         AND bg.total_amount > 0
         AND date(bg.created_at) <= date(?)
         AND bg.unpaid_alert_sent_at IS NULL
       ORDER BY bg.created_at ASC`,
    )
    .bind(cutoffDate)
    .all<OverdueBookingRow>();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// Googleカレンダー取りこぼし補完（#25/#27）
// ---------------------------------------------------------------------------

export interface MissingCalendarBookingRow {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  status: string;
  booking_number: string;
  event_name: string;
  google_calendar_id: string | null;
  contact_name: string | null;
}

/**
 * GoogleカレンダーのイベントIDが未設定のまま（書き込み失敗）の予約を返す（Cron用）。
 * 対象: confirmed/tentative の未来日、カレンダーID設定済みのスペース。
 */
export async function getBookingsMissingCalendarEvent(
  db: D1Database,
  today: string,
  limit = 100,
): Promise<MissingCalendarBookingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.date, b.start_time, b.end_time, b.status,
              bg.booking_number, bg.event_name,
              s.google_calendar_id, c.contact_name
       FROM bookings b
       JOIN booking_groups bg ON bg.id = b.group_id
       JOIN spaces s ON s.id = bg.space_id
       LEFT JOIN customers c ON c.id = bg.customer_id
       WHERE b.google_event_id IS NULL
         AND b.status IN ('confirmed', 'tentative')
         AND b.date >= ?
         AND s.google_calendar_id IS NOT NULL AND s.google_calendar_id <> ''
       ORDER BY b.date ASC LIMIT ?`,
    )
    .bind(today, limit)
    .all<MissingCalendarBookingRow>();
  return results ?? [];
}

/** アラート送信済みとして記録（重複送信防止） */
export async function markUnpaidAlertSent(db: D1Database, groupIds: string[], now: string): Promise<void> {
  if (!groupIds.length) return;
  const placeholders = groupIds.map(() => '?').join(',');
  await db
    .prepare(`UPDATE booking_groups SET unpaid_alert_sent_at = ? WHERE id IN (${placeholders})`)
    .bind(now, ...groupIds)
    .run();
}

// ---------------------------------------------------------------------------
// 定期メール（Cron）: リマインダー・お礼・未入金リマインダー #45/#50/#53
// ---------------------------------------------------------------------------

export interface CronEmailBookingRow {
  id: string;
  booking_number: string;
  event_name: string;
  total_amount: number;
  space_name: string | null;
  contact_name: string | null;
  email: string;
}

/** 送信済みフラグを立てる（column は内部固定の列名のみを渡すこと） */
export async function markGroupEmailFlag(
  db: D1Database,
  column: 'reminder_3d_sent_at' | 'reminder_1d_sent_at' | 'unpaid_reminder_sent_at' | 'thanks_sent_at',
  groupIds: string[],
  now: string,
): Promise<void> {
  if (!groupIds.length) return;
  const placeholders = groupIds.map(() => '?').join(',');
  await db
    .prepare(`UPDATE booking_groups SET ${column} = ? WHERE id IN (${placeholders})`)
    .bind(now, ...groupIds)
    .run();
}

/** グループの利用日程（メール本文用） */
export async function getGroupDays(db: D1Database, groupId: string): Promise<Array<{ date: string; startTime: string; endTime: string }>> {
  const { results } = await db
    .prepare('SELECT date, start_time, end_time FROM bookings WHERE group_id = ? ORDER BY date, start_time')
    .bind(groupId)
    .all<{ date: string; start_time: string; end_time: string }>();
  return (results ?? []).map((r) => ({ date: r.date, startTime: r.start_time, endTime: r.end_time }));
}

/**
 * 利用日リマインダー対象（#45）: confirmed で、利用開始日(最初の日)が targetDate、
 * 指定フラグが未送信、メールあり。当日予約(利用日==本日)は targetDate が未来日なので自然に除外。
 */
export async function getBookingsForUseDateReminder(
  db: D1Database,
  flagColumn: 'reminder_3d_sent_at' | 'reminder_1d_sent_at',
  targetDate: string,
): Promise<CronEmailBookingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT bg.id, bg.booking_number, bg.event_name, bg.total_amount,
              s.name AS space_name, c.contact_name, c.email
       FROM booking_groups bg
       JOIN spaces s ON s.id = bg.space_id
       JOIN customers c ON c.id = bg.customer_id
       WHERE bg.status = 'confirmed' AND c.email IS NOT NULL AND c.email <> ''
         AND bg.${flagColumn} IS NULL
         AND (SELECT MIN(date) FROM bookings WHERE group_id = bg.id) = ?`,
    )
    .bind(targetDate)
    .all<CronEmailBookingRow>();
  return results ?? [];
}

/** 利用後お礼対象（#53）: confirmed で、利用終了日(最後の日)が targetDate(昨日)、未送信、メールあり */
export async function getBookingsForThanks(db: D1Database, targetDate: string): Promise<CronEmailBookingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT bg.id, bg.booking_number, bg.event_name, bg.total_amount,
              s.name AS space_name, c.contact_name, c.email
       FROM booking_groups bg
       JOIN spaces s ON s.id = bg.space_id
       JOIN customers c ON c.id = bg.customer_id
       WHERE bg.status = 'confirmed' AND c.email IS NOT NULL AND c.email <> ''
         AND bg.thanks_sent_at IS NULL
         AND (SELECT MAX(date) FROM bookings WHERE group_id = bg.id) = ?`,
    )
    .bind(targetDate)
    .all<CronEmailBookingRow>();
  return results ?? [];
}

/** 顧客向け未入金リマインダー対象（#50）: 未入金/請求書 で受注から cutoff 以前、未送信、メールあり */
export async function getBookingsForUnpaidCustomerReminder(db: D1Database, cutoffDate: string): Promise<CronEmailBookingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT bg.id, bg.booking_number, bg.event_name, bg.total_amount,
              s.name AS space_name, c.contact_name, c.email
       FROM booking_groups bg
       JOIN spaces s ON s.id = bg.space_id
       JOIN customers c ON c.id = bg.customer_id
       WHERE bg.status = 'confirmed' AND c.email IS NOT NULL AND c.email <> ''
         AND bg.payment_status IN ('unpaid','invoice') AND bg.total_amount > 0
         AND bg.unpaid_reminder_sent_at IS NULL
         AND date(bg.created_at) <= date(?)`,
    )
    .bind(cutoffDate)
    .all<CronEmailBookingRow>();
  return results ?? [];
}

/** チケット商品を削除。発行済みチケットから参照されている場合は非公開化に留める。 */
export async function deleteTicketProduct(db: D1Database, id: string): Promise<{ deleted: boolean }> {
  const ref = await db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE product_id = ?').bind(id).first<{ n: number }>();
  if (ref && ref.n > 0) {
    await db.prepare('UPDATE ticket_products SET is_active = 0 WHERE id = ?').bind(id).run();
    return { deleted: false };
  }
  await db.prepare('DELETE FROM ticket_product_spaces WHERE product_id = ?').bind(id).run();
  await db.prepare('DELETE FROM ticket_products WHERE id = ?').bind(id).run();
  return { deleted: true };
}

/**
 * 会員の保有チケット一覧（マイページ・管理画面用）。
 * today を渡すと、有効期限を過ぎた 'active' チケットを 'expired'（失効）として返す。
 */
export async function getMemberTickets(db: D1Database, customerId: string, today?: string) {
  const statusExpr = today
    ? "CASE WHEN t.status = 'active' AND t.valid_until < ? THEN 'expired' ELSE t.status END AS status"
    : 't.status';
  const binds = today ? [today, customerId] : [customerId];
  const { results } = await db
    .prepare(
      `SELECT t.id, t.name, t.total_hours, t.remaining_hours, t.valid_from, t.valid_until, ${statusExpr},
              (SELECT GROUP_CONCAT(s.name, ' / ') FROM ticket_spaces ts JOIN spaces s ON s.id = ts.space_id WHERE ts.ticket_id = t.id) AS spaces
       FROM tickets t WHERE t.customer_id = ? ORDER BY t.purchased_at DESC`,
    )
    .bind(...binds)
    .all();
  return results ?? [];
}

/** 予約に使える有効チケット（対象スペース・期限・残時間で絞り込み） */
export async function getUsableTicketsForSpace(db: D1Database, customerId: string, spaceId: string, today: string) {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.name, t.remaining_hours, t.valid_until
       FROM tickets t
       WHERE t.customer_id = ? AND t.status = 'active' AND t.remaining_hours > 0
         AND t.valid_from <= ? AND t.valid_until >= ?
         AND (NOT EXISTS (SELECT 1 FROM ticket_spaces ts WHERE ts.ticket_id = t.id)
              OR EXISTS (SELECT 1 FROM ticket_spaces ts WHERE ts.ticket_id = t.id AND ts.space_id = ?))
       ORDER BY t.valid_until`,
    )
    .bind(customerId, today, today, spaceId)
    .all<{ id: string; name: string; remaining_hours: number; valid_until: string }>();
  return results ?? [];
}

export async function getTicketForCustomer(db: D1Database, ticketId: string, customerId: string): Promise<TicketRow | null> {
  return db.prepare('SELECT * FROM tickets WHERE id = ? AND customer_id = ?').bind(ticketId, customerId).first<TicketRow>();
}

/**
 * 予約グループがチケットで支払われているかを検出（予約内容変更時の再計算用）#24
 * ticket_usage を現在のグループの予約行に結び付けて取得する。
 */
export async function getTicketUsageForGroup(
  db: D1Database,
  groupId: string,
): Promise<{ usageId: string; ticketId: string; oldHours: number; remainingHours: number; status: string } | null> {
  const row = await db
    .prepare(
      `SELECT tu.id AS usage_id, tu.ticket_id, tu.hours_consumed AS old_hours,
              t.remaining_hours, t.status
       FROM ticket_usage tu
       JOIN bookings b ON b.id = tu.booking_id
       JOIN tickets t ON t.id = tu.ticket_id
       WHERE b.group_id = ?
       LIMIT 1`,
    )
    .bind(groupId)
    .first<{ usage_id: string; ticket_id: string; old_hours: number; remaining_hours: number; status: string }>();
  if (!row) return null;
  return {
    usageId: row.usage_id,
    ticketId: row.ticket_id,
    oldHours: row.old_hours,
    remainingHours: row.remaining_hours,
    status: row.status,
  };
}

export async function getTicketSpaceIds(db: D1Database, ticketId: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT space_id FROM ticket_spaces WHERE ticket_id = ?').bind(ticketId).all<{ space_id: string }>();
  return (results ?? []).map((r) => r.space_id);
}

/**
 * 予約内容変更でチケット消費を再計算するための D1 文を生成（#24）。
 * 旧消費を戻したうえで新しい消費・残時間・利用履歴を反映する。
 * バッチの外部キー制約（ticket_usage → bookings）を避けるため、
 *  - clearOldUsage: 旧 bookings を削除する前に旧 ticket_usage を削除
 *  - applyNew: 新 bookings を挿入した後に tickets を更新し新 ticket_usage を挿入
 * の2段に分けて返す。
 * ※呼び出し側で coveredAmountForHours により newRemaining/newHours/coveredYen を算出して渡す。
 */
export function buildTicketRescheduleStmts(
  db: D1Database,
  p: {
    usageId: string;
    ticketId: string;
    newRemaining: number;
    newHours: number;
    spaceTotal: number;
    coveredYen: number;
    newFirstBookingId: string;
    now: string;
  },
): { clearOldUsage: D1PreparedStatement; applyNew: D1PreparedStatement[] } {
  const status = p.newRemaining <= 0 ? 'exhausted' : 'active';
  return {
    clearOldUsage: db.prepare('DELETE FROM ticket_usage WHERE id = ?').bind(p.usageId),
    applyNew: [
      db.prepare('UPDATE tickets SET remaining_hours = ?, status = ? WHERE id = ?').bind(p.newRemaining, status, p.ticketId),
      db
        .prepare(
          `INSERT INTO ticket_usage (id, ticket_id, booking_id, hours_consumed, original_price, discounted_price, used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          p.ticketId,
          p.newFirstBookingId,
          p.newHours,
          p.spaceTotal,
          p.spaceTotal - p.coveredYen,
          p.now,
        ),
    ],
  };
}
