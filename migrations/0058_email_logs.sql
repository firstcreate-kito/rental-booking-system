-- メール送信ログ（宛先・種別・日時・成否）を記録し、管理画面から検索できるようにする。
-- 「送ったはず／届いていない」の社内調査を、Resend管理画面を見に行かずに完結できる。
CREATE TABLE IF NOT EXISTS email_logs (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,          -- 送信試行日時（JST・ISO）
  recipients  TEXT NOT NULL,          -- 宛先（カンマ区切り・複数可）
  subject     TEXT NOT NULL,          -- 件名（種別が判別できる）
  kind        TEXT,                   -- 任意タグ（例: weekly_report）
  status      TEXT NOT NULL,          -- sent / failed / skipped
  error       TEXT                    -- 失敗・スキップ理由（任意）
);
CREATE INDEX IF NOT EXISTS idx_email_logs_created ON email_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status);
