-- 0035: 予約の変更履歴（時系列）
--
-- 日時変更・追加請求・返金・キャンセル・入金確認などの経緯を、予約ごとに
-- 人が読める形で時系列に残す。マイページ・管理画面の予約情報に表示する。
-- summary は顧客にも見せる前提の文言にする。
CREATE TABLE booking_events (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES booking_groups(id),
  type       TEXT NOT NULL,   -- reschedule / cancel / refund / additional_issued / additional_paid / payment_confirmed
  summary    TEXT NOT NULL,   -- 例）「日時・内容を変更（合計 ¥7,260→¥10,890）」
  amount     INTEGER,         -- 金額（あれば）
  actor      TEXT,            -- 'admin:foo@example.com' / 'customer' / 'system'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_booking_events_group ON booking_events(group_id);
