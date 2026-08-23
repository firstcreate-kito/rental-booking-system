-- 0036 スペースに「請求書払い（手動・自社口座／Stripe非経由）」の受付可否を追加（#88関連の運用拡張）
-- 手作業で請求書を発行し、入金確認も管理者が手動で行う支払い方法。既定はOFF。
ALTER TABLE spaces ADD COLUMN allow_manual_invoice INTEGER NOT NULL DEFAULT 0;
