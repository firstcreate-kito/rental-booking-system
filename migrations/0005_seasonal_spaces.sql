-- 0005: 季節料金をスペースごとに指定できるようにする
-- seasonal_pricing 1件に対して対象スペースを複数紐付ける中間テーブル。
-- 紐付けが1件も無い季節料金は「全スペース対象」として扱う（後方互換）。

CREATE TABLE seasonal_spaces (
  seasonal_id TEXT NOT NULL REFERENCES seasonal_pricing(id) ON DELETE CASCADE,
  space_id    TEXT NOT NULL REFERENCES spaces(id),
  PRIMARY KEY (seasonal_id, space_id)
);

CREATE INDEX idx_seasonal_spaces_space ON seasonal_spaces(space_id);
