-- #111 週次「今週の予約」まとめメールの宛先（スペース別・複数可）
-- カンマ区切りで複数アドレスを保持する。空の場合は notify_email（#72）にフォールバックし、
-- それも空なら当該スペースへは送信しない（本部への一括送信は行わない＝オーナー宛の設計）。
ALTER TABLE spaces ADD COLUMN weekly_report_recipients TEXT;
