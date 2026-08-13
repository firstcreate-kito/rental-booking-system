/**
 * D1 データアクセス層（Phase 1 で使う分）
 */
import type { HolidayType } from '../lib/calendar';

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
}

/** スペース作成/更新の入力 */
export interface SpaceInput {
  name: string;
  nameEn?: string | null;
  slug?: string | null;
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
  ];
}

export async function insertSpace(db: D1Database, id: string, s: SpaceInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO spaces
       (id, name, name_en, slug, billing_type, weekday_rate, weekend_rate, day_rate_hours,
        weekday_available, weekend_available, slot_minutes, has_minimum, min_hours,
        open_time, close_time, booking_horizon_days, booking_deadline_days, block_name, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, ...bindSpace(s))
    .run();
}

export async function updateSpace(db: D1Database, id: string, s: SpaceInput): Promise<void> {
  await db
    .prepare(
      `UPDATE spaces SET
        name = ?, name_en = ?, slug = ?, billing_type = ?, weekday_rate = ?, weekend_rate = ?, day_rate_hours = ?,
        weekday_available = ?, weekend_available = ?, slot_minutes = ?, has_minimum = ?, min_hours = ?,
        open_time = ?, close_time = ?, booking_horizon_days = ?, booking_deadline_days = ?, block_name = ?, sort_order = ?, is_active = ?
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

// --- 季節料金（管理） ---
export interface SeasonalFullRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  surcharge_pct: number;
  is_active: number;
}

export async function getSeasonalAll(db: D1Database): Promise<SeasonalFullRow[]> {
  const { results } = await db
    .prepare('SELECT id, name, start_date, end_date, surcharge_pct, is_active FROM seasonal_pricing ORDER BY start_date')
    .all<SeasonalFullRow>();
  return results ?? [];
}

export interface SeasonalInput {
  name: string;
  startDate: string;
  endDate: string;
  surchargePct: number;
  isActive: boolean;
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
  return id;
}

export async function updateSeasonal(db: D1Database, id: string, s: SeasonalInput): Promise<void> {
  await db
    .prepare(
      `UPDATE seasonal_pricing SET name = ?, start_date = ?, end_date = ?, surcharge_pct = ?, is_active = ? WHERE id = ?`,
    )
    .bind(s.name, s.startDate, s.endDate, s.surchargePct, s.isActive ? 1 : 0, id)
    .run();
}

export async function deleteSeasonal(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM seasonal_pricing WHERE id = ?').bind(id).run();
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
  filters: { from?: string; to?: string; spaceId?: string; status?: string },
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
    conds.push('b.status = ?');
    binds.push(filters.status);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const { results } = await db
    .prepare(
      `SELECT b.date, b.start_time, b.end_time, b.status, b.price, b.billing_mode,
              bg.booking_number, bg.event_name, bg.source, s.name AS space_name, b.space_id,
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
