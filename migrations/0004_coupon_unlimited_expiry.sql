-- 0004: クーポンの有効期限を任意（無期限）にする
-- valid_until を NULL 許容に変更。NULL = 無期限。
-- SQLite は列の NOT NULL 制約を直接外せないため、テーブル再構築で対応する。

CREATE TABLE discount_coupons_new (
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
  valid_until     TEXT,                -- NULL = 無期限
  staff_memo      TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active'/'exhausted'/'expired'
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO discount_coupons_new
  SELECT id, customer_id, name, code, discount_type, discount_value, total_hours,
         remaining_hours, apply_to, valid_from, valid_until, staff_memo, status,
         created_by, created_at
  FROM discount_coupons;

DROP TABLE discount_coupons;
ALTER TABLE discount_coupons_new RENAME TO discount_coupons;

CREATE INDEX idx_coupons_customer ON discount_coupons(customer_id);
