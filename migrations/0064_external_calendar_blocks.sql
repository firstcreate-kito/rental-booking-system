-- 外部予約（スペースマーケット/インスタベース等・Googleカレンダー連携のみ）を
-- D1に「占有ブロック」として取り込むための専用テーブル。
-- 目的：公式サイトの空き状況ページ（/availability = D1のみ参照）にも外部予約を反映し、
--       毎回のGoogle照会なしで正確な空き表示を高速に出す。
-- 方針：本体の bookings テーブルは汚さない（レポート/サイネージ/未入金アラート等に影響させない）。
--       5分ごとの同期ジョブが upsert＋不要行削除でカレンダーと突き合わせる。
-- id は「GイベントID#日付」（複数日イベントを日別ブロックに展開するため）。
CREATE TABLE IF NOT EXISTS external_calendar_blocks (
  id              TEXT PRIMARY KEY,   -- '<google_event_id>#<YYYY-MM-DD>'
  google_event_id TEXT NOT NULL,      -- 元のGカレンダー予定ID（クリーンアップの突き合わせ用）
  space_id        TEXT NOT NULL,
  date            TEXT NOT NULL,      -- 'YYYY-MM-DD'（JST）
  start_time      TEXT NOT NULL,      -- 'HH:MM'
  end_time        TEXT NOT NULL,      -- 'HH:MM'（日跨ぎは当日ぶんにクランプ）
  summary         TEXT,
  synced_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extblk_space_date ON external_calendar_blocks(space_id, date);
CREATE INDEX IF NOT EXISTS idx_extblk_date ON external_calendar_blocks(date);
