-- サポート用「顧客画面の閲覧（なりすまし表示）」の土台（#サポート効率化）
-- 目的：問い合わせ時に管理者が顧客と同じ画面を安全に確認し、原因特定を早める。
--   ・auth_sessions に「なりすまし発行元の管理者」と「閲覧専用フラグ」を持たせる
--   ・監査ログ（誰が・いつ・どの顧客を・なぜ閲覧したか）を必ず残す
-- 冪等性：このマイグレーションは新規カラム/テーブルの追加のみ（既存データ非破壊）。

-- 通常ログインは impersonated_by=NULL・readonly=0（既定）。
-- なりすまし閲覧セッションは impersonated_by=管理者ID・readonly=1 で発行する。
ALTER TABLE auth_sessions ADD COLUMN impersonated_by TEXT;               -- 管理者ID（NULL＝通常の会員ログイン）
ALTER TABLE auth_sessions ADD COLUMN readonly INTEGER NOT NULL DEFAULT 0; -- 1＝書き込み禁止（閲覧専用）

-- なりすまし閲覧の監査ログ（開始・終了を記録）
CREATE TABLE admin_impersonation_log (
  id             TEXT PRIMARY KEY,
  admin_id       TEXT NOT NULL,
  admin_email    TEXT,
  customer_id    TEXT NOT NULL,
  customer_email TEXT,
  reason         TEXT,             -- 閲覧理由（監査用・任意）
  started_at     TEXT NOT NULL,
  ended_at       TEXT              -- NULL＝閲覧中／値あり＝終了済み
);

-- 「開いたままのセッション」を素早く引くための索引（終了処理・監視用）
CREATE INDEX idx_imp_log_open ON admin_impersonation_log (admin_id, customer_id, ended_at);
