-- 0010 予約のオンライン決済（Stripe/PayPal）状態と決済記録
-- 「予約枠を確保 → すぐ決済」方式。予約は先に confirmed で作成（ダブルブッキング防御が効く）、
-- 決済状態を payment_status で管理し、決済完了 Webhook で 'paid' に更新する。
--   payment_status: 'unpaid'(カード/PayPal未入金) / 'paid'(入金済) / 'invoice'(請求書払い)
--   既存・管理者・商談中の予約は既定 'paid'（＝オンライン未入金の追跡対象外）とする。
ALTER TABLE booking_groups ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'paid';

CREATE TABLE booking_payments (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL REFERENCES booking_groups(id),
  provider          TEXT NOT NULL,                    -- 'stripe' / 'paypal'
  stripe_session_id TEXT UNIQUE,                      -- Stripe Checkout Session ID（冪等キー）
  amount            INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',  -- 'pending' / 'paid'
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at           TEXT
);

CREATE INDEX idx_booking_payments_group ON booking_payments(group_id);
