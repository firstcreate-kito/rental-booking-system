-- 0055: 新規会員登録特典（自動発行クーポン）
--
-- 目的：新規会員登録時に、対象スペース限定の割引クーポンを自動発行する。
--   - 悪用対策として対象スペースを限定（例：防音室A・B／東別院）できる。
--   - ルールはデータ駆動（signup_bonus_rules）。将来、名駅フリー ¥1,000 等を
--     行の追加/編集だけで拡張できる。
--   - 既定は enabled=0（無効）。開始時に enabled=1 に切り替えるだけで発動する。
--
-- 冪等性：この移行は列追加＋テーブル作成＋初期ルール投入。再実行はしない前提
--   （マイグレーションランナーが未適用分のみ適用）。

-- 自動発行クーポンを識別する目印（手動発行＝NULL / 新規登録特典＝'signup'）。
-- 二重発行の防止判定に使う。
ALTER TABLE discount_coupons ADD COLUMN source TEXT;

-- 新規登録特典のルール（データ駆動）。
CREATE TABLE signup_bonus_rules (
  id             TEXT PRIMARY KEY,
  enabled        INTEGER NOT NULL DEFAULT 0,      -- 0=無効(既定) / 1=有効。開始時に1へ。
  name           TEXT NOT NULL,                   -- クーポン表示名（例：新規登録特典 ¥500クーポン）
  discount_type  TEXT NOT NULL DEFAULT 'fixed',   -- 'fixed' / 'percent'
  discount_value INTEGER NOT NULL,                -- 例：500
  total_hours    INTEGER NOT NULL DEFAULT 1,      -- 1=1予約で使い切り（1回のみ）
  validity_days  INTEGER NOT NULL DEFAULT 30,     -- 登録日から「予約する」までの猶予（利用日は先でも可）
  space_ids      TEXT NOT NULL,                   -- 対象スペースID（JSON配列）。空配列[]は全スペース対象。
  staff_memo     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 初期ルール（防音室A・B／東別院24h・¥500・1回・登録から1ヶ月以内に予約）。
-- 既定は enabled=0（無効）。運用開始時に enabled=1 へ切り替える。
INSERT INTO signup_bonus_rules
  (id, enabled, name, discount_type, discount_value, total_hours, validity_days, space_ids, staff_memo)
VALUES
  ('signup-bonus-piano-500', 0, '新規登録特典 ¥500クーポン', 'fixed', 500, 1, 30,
   '["meieki-piano-a","meieki-piano-b","higashibetsuin-piano-24h"]',
   '防音室A・B／東別院24h 限定。登録から1ヶ月以内に予約で利用可（利用日は先でもOK）。開始時に enabled=1 に。');
