-- 0031: 追加請求（差額の後日徴収）を本予約の決済と区別するための種別
--
-- 予約内容変更で料金が上がったとき、差額を Stripe 決済リンクで別途集金する。
-- これを本予約の決済（kind='booking'）と区別できるよう kind を持たせる。
--  kind='booking'    … 予約作成時の決済（既存・既定）
--  kind='additional' … 変更で発生した追加分の決済リンク
ALTER TABLE booking_payments ADD COLUMN kind TEXT NOT NULL DEFAULT 'booking';
