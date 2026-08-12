-- =============================================================================
-- オプション シードデータ（オプションリスト 2026-08-12版・税込み）
--   共通在庫アイテムは 1つのoption行 + 複数space_options で表現。
--   在庫は日単位で「その日の全予約における利用数合計」を都度集計する（追加テーブル不要）。
--   scope は当面すべて 'per_group'（予約全体でアイテムを確保）。
-- =============================================================================

-- options: id, name, category, type, price_type, unit_price, unit_label, max_qty, stock_total, scope, sort_order, is_active
INSERT OR REPLACE INTO options
  (id, name, category, type, price_type, unit_price, unit_label, max_qty, stock_total, scope, sort_order, is_active)
VALUES
  ('opt-table',        'テーブル 180㎝×60㎝',                                  '家具',   'quantity', 'free',     0,    '台', NULL, 16, 'per_group', 1,  1),
  ('opt-chair',        '椅子',                                                 '家具',   'quantity', 'free',     0,    '脚', NULL, 60, 'per_group', 2,  1),
  ('opt-audio-1',      '音響設備（YAMAHA STAGEPAS600i）',                      '音響',   'toggle',   'fixed',    3300, NULL, NULL, 1,  'per_group', 3,  1),
  ('opt-audio-mic1',   '音響設備（STAGEPAS600i）＋ワイヤレスマイク×1本',       '音響',   'toggle',   'fixed',    4400, NULL, NULL, 1,  'per_group', 4,  1),
  ('opt-audio-mic2',   '音響設備（STAGEPAS600i）＋ワイヤレスマイク×2本',       '音響',   'toggle',   'fixed',    5500, NULL, NULL, 1,  'per_group', 5,  1),
  ('opt-mic-stand',    'マイクスタンド',                                       '音響',   'quantity', 'free',     0,    '本', NULL, 2,  'per_group', 6,  1),
  ('opt-table-setup',  '事前テーブルセッティング＆撤収',                       'サービス','toggle',   'fixed',    5500, NULL, NULL, 1,  'per_group', 7,  1),
  ('opt-shoes-fee',    '土足利用料金（清掃料金）',                             'サービス','toggle',   'fixed',    5500, NULL, NULL, 1,  'per_group', 8,  1),
  ('opt-trash-bag',    'ゴミ袋（45L）',                                        '備品',   'quantity', 'per_unit', 1100, '袋', NULL, 10, 'per_group', 9,  1),
  ('opt-projector',    'プロジェクター',                                       '映像',   'toggle',   'free',     0,    NULL, NULL, 1,  'per_group', 10, 1),
  ('opt-screen',       'スクリーン',                                           '映像',   'toggle',   'free',     0,    NULL, NULL, 1,  'per_group', 11, 1),
  ('opt-screen-free',  'スクリーン（自立式）',                                 '映像',   'toggle',   'free',     0,    NULL, NULL, 1,  'per_group', 12, 1),
  ('opt-whiteboard',   'ホワイトボード',                                       '映像',   'toggle',   'free',     0,    NULL, NULL, 1,  'per_group', 13, 1),
  ('opt-radicase',     'ラジカセ',                                             '音響',   'toggle',   'free',     0,    NULL, NULL, 1,  'per_group', 14, 1),
  ('opt-rug',          'ラグ',                                                 '家具',   'quantity', 'free',     0,    '枚', NULL, 2,  'per_group', 15, 1),
  ('opt-baby-bed',     'ベビーベッド',                                         '備品',   'toggle',   'free',     0,    NULL, NULL, 1,  'per_group', 16, 1),
  ('opt-ext-cord',     '延長コード',                                           '備品',   'quantity', 'free',     0,    '本', NULL, 5,  'per_group', 17, 1),
  ('opt-ladder-l',     '脚立（大）2700mm',                                     '備品',   'toggle',   'free',     0,    NULL, NULL, 1,  'per_group', 18, 1),
  ('opt-ladder-s',     '脚立（小）',                                           '備品',   'toggle',   'free',     0,    NULL, NULL, 1,  'per_group', 19, 1),
  ('opt-music-stand',  '譜面台',                                               '備品',   'quantity', 'free',     0,    '台', NULL, 5,  'per_group', 20, 1),
  ('opt-yoga-mat',     'ヨガマット',                                           '備品',   'quantity', 'free',     0,    '枚', NULL, 10, 'per_group', 21, 1),
  ('opt-lan-cable',    'LANケーブル（20m）',                                   '備品',   'quantity', 'free',     0,    '本', NULL, 2,  'per_group', 22, 1),
  ('opt-hanger-rack',  'ハンガーラック',                                       '家具',   'quantity', 'per_unit', 550,  '台', NULL, 17, 'per_group', 23, 1),
  ('opt-fitting-room', 'フィッティングルーム',                                 'サービス','quantity', 'per_unit', 5500, '室', NULL, 2,  'per_group', 24, 1);

-- space_options: スペース×オプションの紐付け（共通在庫は複数スペースに紐付け）
INSERT OR REPLACE INTO space_options (space_id, option_id, is_active) VALUES
  -- 名駅フリースペース専用
  ('meieki-free', 'opt-table', 1),
  ('meieki-free', 'opt-chair', 1),
  ('meieki-free', 'opt-audio-1', 1),
  ('meieki-free', 'opt-audio-mic1', 1),
  ('meieki-free', 'opt-audio-mic2', 1),
  ('meieki-free', 'opt-mic-stand', 1),
  ('meieki-free', 'opt-table-setup', 1),
  ('meieki-free', 'opt-shoes-fee', 1),
  ('meieki-free', 'opt-trash-bag', 1),
  ('meieki-free', 'opt-screen', 1),
  ('meieki-free', 'opt-whiteboard', 1),
  ('meieki-free', 'opt-radicase', 1),
  ('meieki-free', 'opt-rug', 1),
  ('meieki-free', 'opt-baby-bed', 1),
  ('meieki-free', 'opt-ext-cord', 1),
  ('meieki-free', 'opt-ladder-l', 1),
  ('meieki-free', 'opt-ladder-s', 1),
  -- プロジェクター（フリー/エクササイズ/和室 共通在庫）
  ('meieki-free', 'opt-projector', 1),
  ('meieki-exercise', 'opt-projector', 1),
  ('meieki-washitsu', 'opt-projector', 1),
  -- スクリーン自立式（フリー/エクササイズ/和室 共通在庫）
  ('meieki-free', 'opt-screen-free', 1),
  ('meieki-exercise', 'opt-screen-free', 1),
  ('meieki-washitsu', 'opt-screen-free', 1),
  -- ヨガマット（フリー/エクササイズ 共通在庫）
  ('meieki-free', 'opt-yoga-mat', 1),
  ('meieki-exercise', 'opt-yoga-mat', 1),
  -- LANケーブル（フリー/エクササイズ/和室 共通在庫）
  ('meieki-free', 'opt-lan-cable', 1),
  ('meieki-exercise', 'opt-lan-cable', 1),
  ('meieki-washitsu', 'opt-lan-cable', 1),
  -- 譜面台（防音室A/B 共通在庫）
  ('meieki-piano-a', 'opt-music-stand', 1),
  ('meieki-piano-b', 'opt-music-stand', 1),
  -- アルベホール名古屋 専用
  ('albe-hall-nagoya', 'opt-hanger-rack', 1),
  ('albe-hall-nagoya', 'opt-fitting-room', 1);
