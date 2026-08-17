-- 0024 閲覧可能期間（#77）
--   予約可能期間（booking_horizon_days）とは別に、空き状況を「見るだけ」できる期間を持つ。
--   単日予約が先々まで埋まると長期・複数日予約の機会損失になるため、ネット予約は直近のみ／
--   空き閲覧はより先まで、を分離する。view_horizon_days >= booking_horizon_days を想定。
ALTER TABLE spaces ADD COLUMN view_horizon_days INTEGER NOT NULL DEFAULT 180;

-- 既存スペースは既定180日（ADD COLUMN の DEFAULT で全行180に設定済み）。
