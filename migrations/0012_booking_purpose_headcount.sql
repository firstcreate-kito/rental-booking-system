-- 予約に「利用目的」「利用人数」を追加（Googleカレンダー出力の充実／#54関連）
ALTER TABLE booking_groups ADD COLUMN purpose TEXT;
ALTER TABLE booking_groups ADD COLUMN headcount INTEGER;
