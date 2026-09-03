-- チケット（回数券）の有効期限接近メール（#112）用。
-- 二重送信を防ぐため、そのチケットで最後に送った接近通知の段階を記録する。
--   0  = 未送信
--   60 = 「残り約2か月」を送信済み
--   30 = 「残り約1か月」を送信済み
-- 既存チケットは 0（未送信）から開始。有効期限が既に近いものは次回Cronで該当段階を送る。
ALTER TABLE tickets ADD COLUMN expiry_notice_stage INTEGER NOT NULL DEFAULT 0;
