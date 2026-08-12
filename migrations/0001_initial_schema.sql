-- =============================================================================
-- レンタルスペースALBE 予約システム 初期スキーマ (v2.1)
-- 仕様書 v2.0 + 追補 v2.1 を反映
--
-- 主なv2.1の変更点:
--   - 時間帯別料金テーブル (time_zones / space_time_zone_pricing) を廃止
--   - spaces に 1時間単価(平日/土日祝) と 1日料金(時間数) を統合
--   - bookings.status / booking_groups.status に 'tentative'(商談中) を追加
--   - bookings の残置カラムを「1日料金方式(ホテル泊数方式)」に再定義
--   - 管理者セッション admin_sessions を追加
--
-- 備考: SQLite(D1) の BOOLEAN は 0/1 で表現する。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2.1 spaces（スペースマスタ）※料金統合
-- -----------------------------------------------------------------------------
CREATE TABLE spaces (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  name_en               TEXT,
  google_calendar_id    TEXT,
  billing_type          TEXT NOT NULL DEFAULT 'hourly',  -- 'hourly'(時間貸し) / 'block'(1日単位専用)
  weekday_rate          INTEGER,                          -- 平日1時間単価(NULL=平日は時間貸ししない)
  weekend_rate          INTEGER,                          -- 土日祝1時間単価(NULL=土日祝は時間貸ししない)
  day_rate_hours        INTEGER,                          -- 1日料金の課金時間数(NULLなら1日料金なし)。全スペース共通で13運用
  weekday_available     BOOLEAN NOT NULL DEFAULT 1,       -- 平日に予約可能か
  weekend_available     BOOLEAN NOT NULL DEFAULT 1,       -- 土日祝に予約可能か
  slot_minutes          INTEGER NOT NULL DEFAULT 30,      -- 時間選択の刻み(分)
  has_minimum           BOOLEAN NOT NULL DEFAULT 0,
  min_hours             INTEGER NOT NULL DEFAULT 0,
  open_time             TEXT NOT NULL,                    -- '08:00'
  close_time            TEXT NOT NULL,                    -- '22:00'
  booking_horizon_days  INTEGER NOT NULL DEFAULT 180,     -- 何日先まで予約可能
  booking_deadline_days INTEGER,                          -- NULLなら共通設定。利用日の何日前まで受付
  block_name            TEXT,                             -- ブロック名（'終日'等、block時のみ）
  sort_order            INTEGER NOT NULL DEFAULT 0,
  is_active             BOOLEAN NOT NULL DEFAULT 1
);

-- -----------------------------------------------------------------------------
-- 2.4 seasonal_pricing（季節料金）全スペース共通
-- -----------------------------------------------------------------------------
CREATE TABLE seasonal_pricing (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,          -- 'GW'
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  surcharge_pct INTEGER NOT NULL,       -- 30 = +30%
  is_active     BOOLEAN NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- 2.5 campaigns（キャンペーン割引）
-- -----------------------------------------------------------------------------
CREATE TABLE campaigns (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  discount_type  TEXT NOT NULL,         -- 'percent' / 'fixed'
  discount_value INTEGER NOT NULL,
  apply_weekday  BOOLEAN NOT NULL DEFAULT 1,
  apply_weekend  BOOLEAN NOT NULL DEFAULT 1,
  space_id       TEXT REFERENCES spaces(id),  -- NULLなら全スペース対象
  is_active      BOOLEAN NOT NULL DEFAULT 1
);

-- -----------------------------------------------------------------------------
-- 2.6 calendar_holidays（祝日・全体休業日）
-- -----------------------------------------------------------------------------
CREATE TABLE calendar_holidays (
  id   TEXT PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  name TEXT,
  type TEXT NOT NULL              -- 'holiday'(土日祝料金) / 'custom'(同) / 'closed'(予約不可)
);

-- -----------------------------------------------------------------------------
-- 2.7 space_closures（スペース固有の休業日）
-- -----------------------------------------------------------------------------
CREATE TABLE space_closures (
  id       TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  date     TEXT NOT NULL,
  reason   TEXT,
  UNIQUE(space_id, date)
);

-- -----------------------------------------------------------------------------
-- 2.13 customers（顧客）※ status_id は customer_status_config を参照
-- -----------------------------------------------------------------------------
CREATE TABLE customers (
  id                    TEXT PRIMARY KEY,
  email                 TEXT UNIQUE NOT NULL,
  password_hash         TEXT,                  -- NULLならゲスト
  is_registered         BOOLEAN NOT NULL DEFAULT 0,
  company_name          TEXT,
  contact_name          TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  postal_code           TEXT,
  address               TEXT,
  invoice_number        TEXT,                  -- 適格請求書番号
  status_id             TEXT NOT NULL DEFAULT 'general',
  line_user_id          TEXT,
  point_balance         INTEGER NOT NULL DEFAULT 0,
  is_blocked            BOOLEAN NOT NULL DEFAULT 0,
  blocked_reason        TEXT,
  blocked_at            TEXT,
  blocked_by            TEXT,
  auto_upgrade_disabled BOOLEAN NOT NULL DEFAULT 0,
  staff_memo            TEXT,                  -- 社内メモ
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at         TEXT
);

-- -----------------------------------------------------------------------------
-- 2.14 customer_status_config（顧客ステータス設定）
-- -----------------------------------------------------------------------------
CREATE TABLE customer_status_config (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,      -- '一般'/'優良'/'VIP'
  sort_order               INTEGER NOT NULL DEFAULT 0,
  can_self_cancel          BOOLEAN NOT NULL DEFAULT 0,
  cancel_deadline_days     INTEGER,
  can_self_reschedule      BOOLEAN NOT NULL DEFAULT 0,
  reschedule_deadline_days INTEGER,
  auto_upgrade_threshold   INTEGER,            -- 自動昇格に必要な利用回数(NULLなら自動昇格なし)
  is_default               BOOLEAN NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------------
-- 2.15 customer_status_log（ステータス変更履歴）
-- -----------------------------------------------------------------------------
CREATE TABLE customer_status_log (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  old_status_id TEXT,
  new_status_id TEXT NOT NULL,
  change_type   TEXT NOT NULL,     -- 'auto' / 'manual'
  changed_by    TEXT,
  changed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- 2.16 customer_favorites（お気に入りスペース）
-- -----------------------------------------------------------------------------
CREATE TABLE customer_favorites (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  space_id    TEXT NOT NULL REFERENCES spaces(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (customer_id, space_id)
);

-- -----------------------------------------------------------------------------
-- 2.17 auth_sessions（顧客認証セッション）
-- -----------------------------------------------------------------------------
CREATE TABLE auth_sessions (
  token       TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- [v2.1追加] admin_sessions（管理者認証セッション）
-- -----------------------------------------------------------------------------
CREATE TABLE admin_sessions (
  token       TEXT PRIMARY KEY,
  admin_id    TEXT NOT NULL REFERENCES admin_users(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- 2.8 booking_groups（予約グループ）※status に 'tentative' 追加
-- -----------------------------------------------------------------------------
CREATE TABLE booking_groups (
  id               TEXT PRIMARY KEY,
  booking_number   TEXT UNIQUE NOT NULL,   -- 'YYYYMMDD-NNN'
  customer_id      TEXT REFERENCES customers(id),   -- 仮予約(商談中)ではNULL可
  space_id         TEXT NOT NULL REFERENCES spaces(id),
  event_name       TEXT NOT NULL,          -- イベント名(サイネージ表示用)
  total_amount     INTEGER NOT NULL DEFAULT 0,
  payment_method   TEXT,                   -- 'card' / 'invoice'
  status           TEXT NOT NULL DEFAULT 'confirmed', -- 'confirmed'/'tentative'/'cancelled'/'completed'
  source           TEXT NOT NULL DEFAULT 'web',       -- 'web'/'admin'/'google_calendar'
  note             TEXT,                   -- 管理用メモ(商談内容など)
  reschedule_count INTEGER NOT NULL DEFAULT 0,        -- セルフ日時変更の実行回数
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- 2.9 bookings（個別予約・1日分=1レコード）※残置カラム再定義, status拡張
-- -----------------------------------------------------------------------------
CREATE TABLE bookings (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES booking_groups(id),
  space_id        TEXT NOT NULL REFERENCES spaces(id),
  date            TEXT NOT NULL,           -- '2026-04-20'
  start_time      TEXT NOT NULL,           -- '10:00'
  end_time        TEXT NOT NULL,           -- '18:00'
  billable_hours  INTEGER NOT NULL,        -- 課金時間数(1日料金/残置日は day_rate_hours)
  billing_mode    TEXT NOT NULL DEFAULT 'hourly',  -- 'hourly'(時間料金) / 'day'(1日料金)
  is_residence    BOOLEAN NOT NULL DEFAULT 0,      -- 翌日へ荷物を残す日(1日料金適用)
  rate            INTEGER,                 -- 適用した1時間単価(平日/土日祝)
  price           INTEGER NOT NULL,        -- スペース利用料金(この日の分)
  google_event_id TEXT,
  status          TEXT NOT NULL DEFAULT 'confirmed', -- 'confirmed'/'tentative'/'cancelled'/'blocked'/'held'
  block_reason    TEXT,                    -- GCal直接追加時のタイトル
  source          TEXT NOT NULL DEFAULT 'web'
);

-- -----------------------------------------------------------------------------
-- 2.10 options（オプションマスタ）
-- -----------------------------------------------------------------------------
CREATE TABLE options (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,        -- '家具'/'映像'/'音響'等
  type        TEXT NOT NULL,        -- 'toggle' / 'quantity'
  price_type  TEXT NOT NULL,        -- 'free' / 'fixed' / 'per_unit'
  unit_price  INTEGER NOT NULL DEFAULT 0,
  unit_label  TEXT,                 -- '脚'/'台'等
  max_qty     INTEGER,              -- 1予約あたりの上限
  stock_total INTEGER,              -- 総在庫数(NULLなら無制限)。日単位集計
  scope       TEXT NOT NULL,        -- 'per_booking' / 'per_group'
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT 1
);

-- -----------------------------------------------------------------------------
-- 2.11 space_options（スペース×オプション紐付け）
-- -----------------------------------------------------------------------------
CREATE TABLE space_options (
  space_id  TEXT NOT NULL REFERENCES spaces(id),
  option_id TEXT NOT NULL REFERENCES options(id),
  is_active BOOLEAN NOT NULL DEFAULT 1,
  PRIMARY KEY (space_id, option_id)
);

-- -----------------------------------------------------------------------------
-- 2.12 booking_option_selections（予約オプション選択）
-- -----------------------------------------------------------------------------
CREATE TABLE booking_option_selections (
  id         TEXT PRIMARY KEY,
  booking_id TEXT REFERENCES bookings(id),        -- 日程別オプション時
  group_id   TEXT REFERENCES booking_groups(id),  -- 全体オプション時
  option_id  TEXT NOT NULL REFERENCES options(id),
  quantity   INTEGER NOT NULL DEFAULT 1,
  subtotal   INTEGER NOT NULL
);

-- -----------------------------------------------------------------------------
-- 2.18 discount_coupons（割引クーポン）
-- -----------------------------------------------------------------------------
CREATE TABLE discount_coupons (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  name            TEXT NOT NULL,
  code            TEXT UNIQUE NOT NULL,
  discount_type   TEXT NOT NULL,       -- 'percent' / 'fixed'
  discount_value  INTEGER NOT NULL,
  total_hours     INTEGER NOT NULL,
  remaining_hours INTEGER NOT NULL,
  apply_to        TEXT NOT NULL DEFAULT 'space_only',
  valid_from      TEXT NOT NULL,
  valid_until     TEXT NOT NULL,
  staff_memo      TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active'/'exhausted'/'expired'
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- 2.19 coupon_spaces（割引クーポン対象スペース）
-- -----------------------------------------------------------------------------
CREATE TABLE coupon_spaces (
  coupon_id TEXT NOT NULL REFERENCES discount_coupons(id),
  space_id  TEXT NOT NULL REFERENCES spaces(id),
  PRIMARY KEY (coupon_id, space_id)
);

-- -----------------------------------------------------------------------------
-- 2.20 ticket_products（チケット商品マスタ）
-- -----------------------------------------------------------------------------
CREATE TABLE ticket_products (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  total_hours   INTEGER NOT NULL,
  price         INTEGER NOT NULL,
  validity_days INTEGER NOT NULL,       -- 購入日から何日間有効
  is_active     BOOLEAN NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------------
-- 2.21 ticket_product_spaces（チケット商品対象スペース）
-- -----------------------------------------------------------------------------
CREATE TABLE ticket_product_spaces (
  product_id TEXT NOT NULL REFERENCES ticket_products(id),
  space_id   TEXT NOT NULL REFERENCES spaces(id),
  PRIMARY KEY (product_id, space_id)
);

-- -----------------------------------------------------------------------------
-- 2.22 tickets（顧客保有チケット）
-- -----------------------------------------------------------------------------
CREATE TABLE tickets (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  product_id      TEXT REFERENCES ticket_products(id),
  name            TEXT NOT NULL,
  total_hours     INTEGER NOT NULL,
  remaining_hours INTEGER NOT NULL,
  valid_from      TEXT NOT NULL,
  valid_until     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active'/'exhausted'/'expired'
  purchased_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- 2.23 ticket_spaces（チケット対象スペース）
-- -----------------------------------------------------------------------------
CREATE TABLE ticket_spaces (
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  space_id  TEXT NOT NULL REFERENCES spaces(id),
  PRIMARY KEY (ticket_id, space_id)
);

-- -----------------------------------------------------------------------------
-- 2.24 coupon_usage / ticket_usage（利用履歴）
-- -----------------------------------------------------------------------------
CREATE TABLE coupon_usage (
  id               TEXT PRIMARY KEY,
  coupon_id        TEXT NOT NULL REFERENCES discount_coupons(id),
  booking_id       TEXT NOT NULL REFERENCES bookings(id),
  hours_consumed   INTEGER NOT NULL,
  original_price   INTEGER NOT NULL,
  discounted_price INTEGER NOT NULL,
  used_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ticket_usage (
  id               TEXT PRIMARY KEY,
  ticket_id        TEXT NOT NULL REFERENCES tickets(id),
  booking_id       TEXT NOT NULL REFERENCES bookings(id),
  hours_consumed   INTEGER NOT NULL,
  original_price   INTEGER NOT NULL,
  discounted_price INTEGER NOT NULL,
  used_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- 2.25 point_log（ポイント履歴）
-- -----------------------------------------------------------------------------
CREATE TABLE point_log (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  type          TEXT NOT NULL,       -- 'earn'/'use'/'manual_add'/'manual_remove'
  amount        INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  group_id      TEXT REFERENCES booking_groups(id),
  description   TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- 2.26 custom_fields（カスタムフィールド定義）
-- -----------------------------------------------------------------------------
CREATE TABLE custom_fields (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL REFERENCES spaces(id),
  label       TEXT NOT NULL,
  field_type  TEXT NOT NULL,     -- 'text'/'select'/'checkbox'
  options     TEXT,              -- JSON配列(select/checkbox時)
  is_required BOOLEAN NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT 1
);

-- -----------------------------------------------------------------------------
-- 2.27 custom_field_values（カスタムフィールド回答）
-- -----------------------------------------------------------------------------
CREATE TABLE custom_field_values (
  id       TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES booking_groups(id),
  field_id TEXT NOT NULL REFERENCES custom_fields(id),
  value    TEXT
);

-- -----------------------------------------------------------------------------
-- 2.28 documents（書類管理）
-- -----------------------------------------------------------------------------
CREATE TABLE documents (
  id             TEXT PRIMARY KEY,
  group_id       TEXT NOT NULL REFERENCES booking_groups(id),
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  type           TEXT NOT NULL,          -- 'invoice' / 'receipt'
  booking_number TEXT NOT NULL,
  pdf_url        TEXT,
  public_token   TEXT UNIQUE NOT NULL,
  total_amount   INTEGER NOT NULL,
  issued_at      TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL DEFAULT 'issued'  -- 'issued' / 'voided'
);

-- -----------------------------------------------------------------------------
-- 2.29 booking_adjustments（差額履歴）
-- -----------------------------------------------------------------------------
CREATE TABLE booking_adjustments (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES booking_groups(id),
  type            TEXT NOT NULL,        -- 'surcharge' / 'refund'
  amount          INTEGER NOT NULL,
  payment_method  TEXT NOT NULL,        -- 'stripe'/'invoice'/'bank_transfer'
  requested_date  TEXT,
  requested_start TEXT,
  requested_end   TEXT,
  bank_name       TEXT,
  branch_name     TEXT,
  account_type    TEXT,                 -- 'normal' / 'checking'
  account_number  TEXT,
  account_holder  TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending'/'completed'/'rejected'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);

-- -----------------------------------------------------------------------------
-- 2.30 cancel_policies（キャンセルポリシー）
-- -----------------------------------------------------------------------------
CREATE TABLE cancel_policies (
  id          TEXT PRIMARY KEY,
  space_id    TEXT REFERENCES spaces(id),  -- NULLなら共通ポリシー
  days_before INTEGER NOT NULL,            -- 利用日の何日前(0=当日)
  charge_pct  INTEGER NOT NULL,            -- キャンセル料率(%)
  cutoff_time TEXT,                        -- その日の適用開始時刻(例'17:00'。NULLは'00:00'扱い)
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------------
-- 2.31 cancellation_log（キャンセル履歴）
-- -----------------------------------------------------------------------------
CREATE TABLE cancellation_log (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL REFERENCES booking_groups(id),
  booking_id        TEXT NOT NULL REFERENCES bookings(id),
  customer_id       TEXT NOT NULL,
  cancelled_at      TEXT NOT NULL DEFAULT (datetime('now')),
  days_before       INTEGER NOT NULL,
  charge_pct        INTEGER NOT NULL,
  original_price    INTEGER NOT NULL,
  cancel_fee        INTEGER NOT NULL,
  collection_status TEXT NOT NULL DEFAULT 'pending'  -- 'pending' / 'collected'
);

-- -----------------------------------------------------------------------------
-- 2.32 blacklist（ブラックリスト）
-- -----------------------------------------------------------------------------
CREATE TABLE blacklist (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,       -- 'email' / 'phone'
  value       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  source      TEXT NOT NULL,       -- 'auto' / 'manual'
  customer_id TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(type, value)
);

-- -----------------------------------------------------------------------------
-- 2.33 admin_users（管理者）
-- -----------------------------------------------------------------------------
CREATE TABLE admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',  -- 'owner'/'manager'/'staff'
  is_active     BOOLEAN NOT NULL DEFAULT 1
);

-- -----------------------------------------------------------------------------
-- 2.34 space_notifications（スペース別通知先）
-- -----------------------------------------------------------------------------
CREATE TABLE space_notifications (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL REFERENCES spaces(id),
  email         TEXT NOT NULL,
  on_booking    BOOLEAN NOT NULL DEFAULT 1,
  on_cancel     BOOLEAN NOT NULL DEFAULT 1,
  on_reschedule BOOLEAN NOT NULL DEFAULT 1,
  UNIQUE(space_id, email)
);

-- -----------------------------------------------------------------------------
-- 2.35 notification_log（通知ログ）
-- -----------------------------------------------------------------------------
CREATE TABLE notification_log (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,     -- 'booking_confirmed'/'reminder'/'cancelled'/...
  recipient   TEXT NOT NULL,     -- 'customer' / 'admin'
  channel     TEXT NOT NULL,     -- 'email' / 'line'
  customer_id TEXT,
  group_id    TEXT,
  status      TEXT NOT NULL,     -- 'sent' / 'failed' / 'skipped'
  skip_reason TEXT,
  sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- 2.36 email_templates（メールテンプレート）
-- -----------------------------------------------------------------------------
CREATE TABLE email_templates (
  id            TEXT PRIMARY KEY,
  type          TEXT UNIQUE NOT NULL,
  subject       TEXT NOT NULL,
  body_template TEXT NOT NULL,       -- {{customer_name}}等のプレースホルダ
  is_active     BOOLEAN NOT NULL DEFAULT 1,
  updated_at    TEXT
);

-- -----------------------------------------------------------------------------
-- 2.37 sync_state（Google Calendar同期状態）
-- -----------------------------------------------------------------------------
CREATE TABLE sync_state (
  space_id        TEXT PRIMARY KEY REFERENCES spaces(id),
  calendar_id     TEXT NOT NULL,
  channel_id      TEXT,
  channel_expiry  TEXT,
  last_sync_token TEXT,
  last_synced_at  TEXT
);

-- -----------------------------------------------------------------------------
-- 2.38 signage_tokens（サイネージ認証）
-- -----------------------------------------------------------------------------
CREATE TABLE signage_tokens (
  space_id   TEXT PRIMARY KEY REFERENCES spaces(id),
  token      TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- 2.39 system_settings（システム設定）
-- -----------------------------------------------------------------------------
CREATE TABLE system_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- =============================================================================
-- インデックス（検索性能）
-- =============================================================================
CREATE INDEX idx_bookings_space_date   ON bookings(space_id, date);
CREATE INDEX idx_bookings_group        ON bookings(group_id);
CREATE INDEX idx_bookings_status       ON bookings(status);
CREATE INDEX idx_booking_groups_cust   ON booking_groups(customer_id);
CREATE INDEX idx_booking_groups_space  ON booking_groups(space_id);
CREATE INDEX idx_boptions_booking      ON booking_option_selections(booking_id);
CREATE INDEX idx_boptions_group        ON booking_option_selections(group_id);
CREATE INDEX idx_customers_status      ON customers(status_id);
CREATE INDEX idx_tickets_customer      ON tickets(customer_id);
CREATE INDEX idx_coupons_customer      ON discount_coupons(customer_id);
CREATE INDEX idx_pointlog_customer     ON point_log(customer_id);
CREATE INDEX idx_documents_group       ON documents(group_id);
CREATE INDEX idx_space_closures_date   ON space_closures(date);
CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);
