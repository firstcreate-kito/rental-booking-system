-- =============================================================================
-- デモ用テストデータ（会員ログイン＋クーポン/ポイントの動作確認用）
--   ※ 開発・デモ専用。本番には投入しないこと。
--
--   テスト会員:
--     Email    : demo-member@albe.test
--     Password : demopass123
--     ポイント : 3000P 保有
--   保有クーポン:
--     コード   : WELCOME20 （20%OFF・残10時間・対象: フリー/エクササイズ/和室/アルベホール）
-- =============================================================================

-- テスト会員（パスワードは PBKDF2 ハッシュ。平文は demopass123）
INSERT OR REPLACE INTO customers
  (id, email, password_hash, is_registered, contact_name, phone, status_id, point_balance, created_at)
VALUES
  ('demo-member', 'demo-member@albe.test',
   'pbkdf2$100000$TFzqRqwR3gj6unwIqE+l2A==$/M9Sarh9nNNxT897Fclfy5qXkzviLfYrD1TKBawtk5g=',
   1, '会員デモ', '09000000000', 'general', 3000, datetime('now'));

-- ポイント履歴（付与の記録）
INSERT OR REPLACE INTO point_log (id, customer_id, type, amount, balance_after, description, created_at)
VALUES ('demo-point-1', 'demo-member', 'manual_add', 3000, 3000, 'デモ用初期ポイント', datetime('now'));

-- 割引クーポン（20%OFF・残10時間）
INSERT OR REPLACE INTO discount_coupons
  (id, customer_id, name, code, discount_type, discount_value, total_hours, remaining_hours,
   apply_to, valid_from, valid_until, status, created_at)
VALUES
  ('demo-coupon-1', 'demo-member', '新規会員20%OFF', 'WELCOME20', 'percent', 20, 10, 10,
   'space_only', '2026-01-01', '2027-12-31', 'active', datetime('now'));

-- クーポン対象スペース
INSERT OR REPLACE INTO coupon_spaces (coupon_id, space_id) VALUES
  ('demo-coupon-1', 'meieki-free'),
  ('demo-coupon-1', 'meieki-exercise'),
  ('demo-coupon-1', 'meieki-washitsu'),
  ('demo-coupon-1', 'albe-hall-nagoya');
