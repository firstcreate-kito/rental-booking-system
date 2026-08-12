-- =============================================================================
-- 開発用シードデータ (v2.1)
--   - spaces: 実料金表(2026-08-12版)を反映
--   - customer_status_config: 一般/優良/VIP のデフォルト
--   - system_settings: 主要設定のデフォルト
--
-- 冪等性のため INSERT OR REPLACE を使用（再実行可）。
-- ※ day_rate_hours=13 は「営業14時間→1日料金は13時間分」を意味し、
--    実料金表(1日料金 ÷ 1時間料金 = 13.0)と一致する。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- spaces（スペースマスタ）
-- 列: id, name, billing_type, weekday_rate, weekend_rate, day_rate_hours,
--     slot_minutes, has_minimum, min_hours, open_time, close_time,
--     booking_horizon_days, booking_deadline_days, block_name, sort_order, is_active
-- -----------------------------------------------------------------------------
INSERT OR REPLACE INTO spaces
  (id, name, billing_type, weekday_rate, weekend_rate, day_rate_hours,
   weekday_available, weekend_available,
   slot_minutes, has_minimum, min_hours, open_time, close_time,
   booking_horizon_days, booking_deadline_days, block_name, sort_order, is_active)
VALUES
  ('albe-hall-nagoya',        'アルベホール名古屋',                       'hourly', 7260, 10890, 13,   1, 1, 30, 1, 3, '08:00', '22:00', 60,  1, NULL, 1, 1),
  ('albe-event-sakae',        'アルベイベントスペース栄',                 'hourly', 7260, 10890, 13,   1, 1, 30, 1, 3, '08:00', '22:00', 60,  1, NULL, 2, 1),
  ('meieki-free',             '名駅フリースペース',                       'hourly', 4840, 7260,  13,   1, 1, 30, 1, 1, '08:00', '22:00', 90,  0, NULL, 3, 1),
  ('meieki-exercise',         '名駅エクササイズスペース',                 'hourly', 2200, 2200,  NULL, 1, 1, 30, 1, 1, '08:00', '22:00', 180, 0, NULL, 4, 1),
  ('meieki-washitsu',         '名駅和室スペース',                         'hourly', 3080, 5060,  13,   1, 1, 30, 1, 1, '08:00', '22:00', 180, 0, NULL, 5, 1),
  ('meieki-piano-a',          '名駅防音室グランドピアノ練習室（A）',      'hourly', 1540, 1540,  NULL, 1, 1, 30, 1, 1, '08:00', '22:00', 180, 0, NULL, 6, 1),
  ('meieki-piano-b',          '名駅防音室グランドピアノ練習室（B）',      'hourly', 1540, 1540,  NULL, 1, 1, 30, 1, 1, '08:00', '22:00', 180, 0, NULL, 7, 1),
  ('higashibetsuin-piano-24h','東別院防音室24時間グランドピアノ音楽練習室','hourly', 1650, 1650,  NULL, 1, 1, 30, 1, 1, '00:00', '23:59', 180, 0, NULL, 8, 1);

-- 北岡崎倉庫スペース: 土日祝のみ営業・最長7時間・時間料金5500円のみ（1日料金なし）。
--   平日は貸出なし(weekday_available=0, weekday_rate=NULL)。
--   受付開始(horizon)は暫定180日前。締切は利用日5日前(deadline=5)。※horizonは運用で調整可。
INSERT OR REPLACE INTO spaces
  (id, name, billing_type, weekday_rate, weekend_rate, day_rate_hours,
   weekday_available, weekend_available,
   slot_minutes, has_minimum, min_hours, open_time, close_time,
   booking_horizon_days, booking_deadline_days, block_name, sort_order, is_active)
VALUES
  ('kitaokazaki-warehouse',   '北岡崎倉庫スペース',                       'hourly', NULL, 5500,  NULL, 0, 1, 30, 1, 3, '10:00', '17:00', 180, 5, NULL, 9, 1);

-- -----------------------------------------------------------------------------
-- customer_status_config（顧客ステータス設定）※仕様2.14のデフォルト
--   一般 : セルフキャンセル不可 / セルフ日時変更不可 / 5回で優良へ自動昇格
--   優良 : セルフキャンセル可(7日前) / 日時変更不可 / 自動昇格なし
--   VIP  : セルフキャンセル可(3日前) / 日時変更可(3日前) / 自動昇格なし
-- -----------------------------------------------------------------------------
INSERT OR REPLACE INTO customer_status_config
  (id, name, sort_order, can_self_cancel, cancel_deadline_days,
   can_self_reschedule, reschedule_deadline_days, auto_upgrade_threshold, is_default)
VALUES
  ('general', '一般', 1, 0, NULL, 0, NULL, 5,    1),
  ('premium', '優良', 2, 1, 7,    0, NULL, NULL, 0),
  ('vip',     'VIP',  3, 1, 3,    1, 3,    NULL, 0);

-- -----------------------------------------------------------------------------
-- cancel_policies（キャンセルポリシー）
--   基本(共通, space_id=NULL): 31日以前0% / 30〜15日前50% / 14日前〜前日80% / 当日100%
--   特別(防音室・ピアノ練習室): 上記に加え「前日17:00以降100%」
-- -----------------------------------------------------------------------------
INSERT OR REPLACE INTO cancel_policies (id, space_id, days_before, charge_pct, cutoff_time, sort_order) VALUES
  ('cp-common-30', NULL, 30, 50,  NULL,    1),
  ('cp-common-14', NULL, 14, 80,  NULL,    2),
  ('cp-common-00', NULL, 0,  100, NULL,    3);

-- 特別ポリシー: 名駅防音室A/B・東別院ピアノ（前日17:00以降100%）
INSERT OR REPLACE INTO cancel_policies (id, space_id, days_before, charge_pct, cutoff_time, sort_order) VALUES
  ('cp-piano-a-30', 'meieki-piano-a', 30, 50,  NULL,    1),
  ('cp-piano-a-14', 'meieki-piano-a', 14, 80,  NULL,    2),
  ('cp-piano-a-01', 'meieki-piano-a', 1,  100, '17:00', 3),
  ('cp-piano-b-30', 'meieki-piano-b', 30, 50,  NULL,    1),
  ('cp-piano-b-14', 'meieki-piano-b', 14, 80,  NULL,    2),
  ('cp-piano-b-01', 'meieki-piano-b', 1,  100, '17:00', 3),
  ('cp-higashi-30', 'higashibetsuin-piano-24h', 30, 50,  NULL,    1),
  ('cp-higashi-14', 'higashibetsuin-piano-24h', 14, 80,  NULL,    2),
  ('cp-higashi-01', 'higashibetsuin-piano-24h', 1,  100, '17:00', 3);

-- -----------------------------------------------------------------------------
-- system_settings（システム設定）※仕様2.39の主要キー
-- -----------------------------------------------------------------------------
INSERT OR REPLACE INTO system_settings (key, value) VALUES
  ('default_booking_deadline_days', '0'),      -- 予約受付締切デフォルト(0=当日まで)
  ('monthly_cancel_limit',          '2'),      -- 月間セルフキャンセル上限
  ('availability_threshold',        '50'),     -- カレンダー○/△の閾値(%)
  ('reminder_time',                 '18:00'),  -- 前日リマインダー送信時刻
  ('point_rate',                    '1'),      -- ポイント付与率(%)
  ('default_cancel_policy',         '1');       -- 共通キャンセルポリシー使用フラグ
