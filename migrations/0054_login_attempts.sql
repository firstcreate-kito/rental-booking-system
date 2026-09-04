-- ログイン試行のレート制限（総当たり・クレデンシャルスタッフィング対策）
-- 失敗のたびに1行記録し、一定時間内の失敗回数が上限を超えたらロックする。
-- 成功時は該当キーの記録を削除。古い記録は定期クリーンアップ（Cron）で削除する。
-- 冪等性：テーブル追加のみ。

CREATE TABLE login_attempts (
  scope      TEXT NOT NULL,   -- 'admin' | 'customer'
  key        TEXT NOT NULL,   -- 'email:<小文字メール>' または 'ip:<IP>'
  created_at TEXT NOT NULL    -- 'YYYY-MM-DD HH:MM:SS'（JST）
);

CREATE INDEX idx_login_attempts ON login_attempts (scope, key, created_at);
