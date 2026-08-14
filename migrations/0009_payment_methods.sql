-- 0009 施設ごとの支払い方法（カード=Stripe／PayPal／請求書）と請求書名
-- 直前予約が多いスペース（防音室など）はオンライン決済のみ、法人利用の多いスペースは請求書払いも可。
-- ※実際の決済連携（Stripe / PayPal）は後日。まずは選択・記録・テストまで。
ALTER TABLE spaces ADD COLUMN allow_card BOOLEAN NOT NULL DEFAULT 1;      -- カード決済(Stripe)可
ALTER TABLE spaces ADD COLUMN allow_paypal BOOLEAN NOT NULL DEFAULT 0;    -- PayPal 可
ALTER TABLE spaces ADD COLUMN allow_invoice BOOLEAN NOT NULL DEFAULT 0;   -- 請求書払い可

-- 予約グループに請求書名（請求書払い時の宛名）を追加。payment_method は 0001 で既存。
-- payment_method には 'stripe' / 'paypal' / 'invoice' を格納する。
ALTER TABLE booking_groups ADD COLUMN invoice_name TEXT;

-- 法人利用の多い施設は請求書払いを有効化（アルベホール名古屋・名駅フリースペース）
UPDATE spaces SET allow_invoice = 1 WHERE id IN ('albe-hall-nagoya', 'meieki-free');
