-- 未入金アラート（#41/#42）
-- 銀行振込等で予約枠を確保したまま入金されないケースを、定期実行(Cron)で検知して
-- 管理者へアラートメールを送る。重複送信を防ぐため送信済み時刻を記録する。
ALTER TABLE booking_groups ADD COLUMN unpaid_alert_sent_at TEXT;
