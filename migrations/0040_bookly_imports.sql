-- 公開切替：Bookly既存予約の移行（枠インポート）の冪等性トラッキング。
-- bookly_key = 'spaceId|YYYY-MM-DD|HH:MM'（1枠1キー）。取り込み済みキーは再実行でスキップ。
-- ロールバックは source='bookly' の予約とGoogle予定を消し、この表も掃除する。
CREATE TABLE IF NOT EXISTS bookly_imports (
  bookly_key  TEXT PRIMARY KEY,      -- 'spaceId|date|HH:MM'
  group_id    TEXT NOT NULL,         -- 作成した booking_groups.id
  space_id    TEXT NOT NULL,
  date        TEXT NOT NULL,
  start_time  TEXT NOT NULL,
  category    TEXT NOT NULL,         -- customer / customer_ticket / block / mirror
  bookly_id   TEXT,                  -- 参照用：元Bookly行ID
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookly_imports_group ON bookly_imports(group_id);
