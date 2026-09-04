-- 管理者ログインの二段階認証（2FA・TOTP）用カラム（個人情報保護の強化）
-- 管理画面は全顧客の個人情報にアクセスできるため、認証を多要素化する。
-- 冪等性：カラム追加のみ（既存データ非破壊）。既定は 2FA 無効（totp_enabled=0）。

ALTER TABLE admin_users ADD COLUMN totp_secret TEXT;                       -- Base32シークレット（NULL=未設定/未確定）
ALTER TABLE admin_users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0; -- 1=2FA有効（ログイン時にコード必須）
ALTER TABLE admin_users ADD COLUMN totp_recovery_codes TEXT;               -- リカバリコードのハッシュ（JSON配列・端末紛失時用）
