-- =============================================================================
-- 0042_remove_demo_seed.sql
-- 公開前のセキュリティ対応：デモ用シード（seeds/demo.sql）が万一いずれかの環境に
-- 投入されていた場合に備え、デモ会員・デモ管理者と関連データを確実に削除する。
--   - デモ会員   : demo-member / demo-member@albe.test（ポイント・クーポン付き）
--   - デモ管理者 : demo-admin  / admin@albe.test（owner権限）
-- 冪等：該当行が無ければ何も起きない（DELETE の no-op）。子から順に削除する。
-- =============================================================================

-- クーポン対象スペース → ポイント履歴 → クーポン → 会員 の順（FK・孤児防止）
DELETE FROM coupon_spaces   WHERE coupon_id = 'demo-coupon-1';
DELETE FROM discount_coupons WHERE id = 'demo-coupon-1' OR customer_id = 'demo-member';
DELETE FROM point_log        WHERE id = 'demo-point-1' OR customer_id = 'demo-member';
DELETE FROM customers        WHERE id = 'demo-member' OR email = 'demo-member@albe.test';

-- デモ管理者（owner権限）を削除
DELETE FROM admin_users      WHERE id = 'demo-admin' OR email = 'admin@albe.test';
