-- 0025 ポイント有効期限（#78）
--   最終活動（獲得または利用）から1年でポイントを失効させる（ローリング）。
--   失効判定は point_log の最終 created_at を基準に算出するため、残高以外の追加列は
--   「期限接近メールの重複防止」用のみ。
--   points_expiry_notified_on … 直近に「期限接近」を案内した有効期限日（YYYY-MM-DD）。
--     期限が延長（新たな活動）されると値が変わるため、新しい期限に対して再通知できる。
ALTER TABLE customers ADD COLUMN points_expiry_notified_on TEXT;
