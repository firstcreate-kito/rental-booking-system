-- 予約フォームの追加標準項目（#60）
-- 過去のご利用実績・ALBEを知ったきっかけ（統計・顧客理解のため保存）。
-- ※利用目的(purpose)・利用人数(headcount)は 0012 で追加済み。
ALTER TABLE booking_groups ADD COLUMN past_use TEXT;         -- 'experienced'（利用経験あり）/ 'first'（なし）
ALTER TABLE booking_groups ADD COLUMN referral_source TEXT;  -- ネット検索 / ポータルサイト / 知人からの紹介 / 看板 / その他
