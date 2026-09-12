-- 受付開始日（この日から予約可）。closing_date（受付最終日）の対。
-- NULL=制限なし（従来どおり）。オープン前の新スペースで、カレンダーは表示しつつ
-- 開始日より前の予約を不可にするために使う。'YYYY-MM-DD'。
ALTER TABLE spaces ADD COLUMN opening_date TEXT;
