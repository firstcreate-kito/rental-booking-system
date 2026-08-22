-- 0029: 返金・追加請求のための支払い参照IDを保存する
--
-- これまで booking_payments には Stripe Checkout Session ID（照合キー）しか
-- 保存していなかった。返金は「payment_intent 単位」（Stripe）／「capture 単位」
-- （PayPal）で行うため、あとから管理者が承認して返金できるよう、実際に決済が
-- 確定したときの参照IDを保存する。既存行は NULL のまま（過去分は手動返金で対応）。
ALTER TABLE booking_payments ADD COLUMN stripe_payment_intent TEXT;  -- Stripe の payment_intent（カード/銀行振込/コンビニ返金用）
ALTER TABLE booking_payments ADD COLUMN paypal_capture_id     TEXT;  -- PayPal のキャプチャID（返金用）
ALTER TABLE booking_payments ADD COLUMN refunded_amount       INTEGER NOT NULL DEFAULT 0;  -- 返金済み累計（円・一部返金対応）
