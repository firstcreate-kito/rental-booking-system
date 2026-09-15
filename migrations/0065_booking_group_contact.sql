-- 商談中（顧客未紐付け）予約の連絡先をグループに保存できるようにする。
-- 背景：商談中の仮押さえ（customer_id = NULL）は customers に紐づかないため、
--   担当者名・電話・メールの保存先が無く、管理画面で編集できなかった。
--   customers テーブルは email(UNIQUE NOT NULL)/contact_name/phone が必須で、
--   情報が揃わない見込み客をそのまま顧客登録するのは不適切。よってグループ側に
--   軽量な連絡先カラムを持たせる（顧客に紐づく予約は従来通り customers を編集）。
ALTER TABLE booking_groups ADD COLUMN contact_name  TEXT;
ALTER TABLE booking_groups ADD COLUMN contact_phone TEXT;
ALTER TABLE booking_groups ADD COLUMN contact_email TEXT;
