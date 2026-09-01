-- 予約フォームのお客様情報に「ご要望・メッセージ」欄（任意）を追加（顧客→運営への自由記述）。
-- booking_groups に自由記述を保持する。空欄可（NULL）。
ALTER TABLE booking_groups ADD COLUMN customer_message TEXT;
