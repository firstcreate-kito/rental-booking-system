-- 0019 ポイント付与（獲得側）#70
-- 利用完了（利用日経過）後にポイントを付与する。二重付与を防ぐため付与日時を記録する。
-- points_awarded_at に日時が入っていれば付与済み（0ポイントで対象外だった場合も日時を入れて再走査を防ぐ）。
ALTER TABLE booking_groups ADD COLUMN points_awarded_at TEXT;
