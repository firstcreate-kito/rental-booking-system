-- 定期メール（Cron）の重複送信防止フラグ（#45/#50/#53）
ALTER TABLE booking_groups ADD COLUMN reminder_3d_sent_at TEXT;   -- 利用3日前リマインダー
ALTER TABLE booking_groups ADD COLUMN reminder_1d_sent_at TEXT;   -- 利用1日前リマインダー
ALTER TABLE booking_groups ADD COLUMN unpaid_reminder_sent_at TEXT; -- 未入金リマインダー（顧客向け）
ALTER TABLE booking_groups ADD COLUMN thanks_sent_at TEXT;        -- 利用後お礼
