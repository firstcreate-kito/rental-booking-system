-- 0061 で追加した idx_bookings_date_status(date, status) は、SQLite の最適化器が
-- 「status の等値シーク（既存 idx_bookings_status）」を優先するため実際には選ばれず、
-- 期待した日付レンジスキャンにならなかった（検証: EXPLAIN QUERY PLAN で idx_bookings_status が選択）。
--
-- getOccupyingBookingsAllSpaces のクエリは status IN (...) の等値 + date の範囲 の複合条件。
-- 先頭列を status、次に date にした複合インデックスなら、status を等値シークしつつ
-- その中で date 範囲を絞り込めるため、最適化器がこの1本で両条件を満たすインデックスを選ぶ。
-- 検証(staging): このインデックスで rows_read 462 相当 → 26 まで低下（対象期間内の行数に比例）。
--
-- したがって (date, status) は破棄し、(status, date) を正とする。冪等（IF NOT EXISTS / IF EXISTS）。
DROP INDEX IF EXISTS idx_bookings_date_status;
CREATE INDEX IF NOT EXISTS idx_bookings_status_date ON bookings(status, date);
