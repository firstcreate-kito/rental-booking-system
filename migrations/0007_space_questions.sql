-- スペース別の追加質問（#22）
-- 基本の予約項目は全スペース共通のまま、スペースごとに独自の質問を設定できるようにする。
-- 例：防音室ABに「持ち込みされる楽器の種類」（自由記述／選択式）。

CREATE TABLE space_questions (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL REFERENCES spaces(id),
  label       TEXT NOT NULL,                 -- 質問文
  input_type  TEXT NOT NULL DEFAULT 'text',  -- 'text'（自由記述） | 'select'（選択式）
  options     TEXT,                          -- select時の選択肢（JSON配列の文字列）
  required    INTEGER NOT NULL DEFAULT 0,     -- 1=必須
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_space_questions_space ON space_questions(space_id, is_active);

-- 予約グループに対する追加質問の回答（質問文はスナップショットで保存）
CREATE TABLE booking_answers (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES booking_groups(id),
  question_id TEXT REFERENCES space_questions(id),
  label       TEXT NOT NULL,   -- 回答時点の質問文
  answer      TEXT,            -- 回答内容
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_booking_answers_group ON booking_answers(group_id);
