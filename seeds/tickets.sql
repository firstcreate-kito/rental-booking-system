-- =============================================================================
-- チケット商品マスタ シードデータ（販売中のチケット・2026-08-14版）#24
--   テーブル定義は migrations/0001 で作成済み。ここでは販売中のチケット内容を投入する。
--   有効日数(validity_days)はエクセルに記載が無いため 180日(約6か月) を暫定値とした（管理画面で変更可）。
--   注: 東別院 12時間 の販売料金 1650円 はエクセル記載のまま。他の価格帯(6h=8250/19h=24750/26h=33000)から
--       16500円 の誤記の可能性が高いため、管理画面から修正できるようにしてある。
--   ※ spaces を参照する外部キーを持つため、seed.sql（スペース定義）の後に実行すること。
-- =============================================================================

-- 名駅防音室A・B共通チケット（対象: meieki-piano-a / meieki-piano-b）
INSERT OR REPLACE INTO ticket_products (id, name, total_hours, price, validity_days, is_active, sort_order) VALUES
  ('tkp-meieki-ab-6',  '名駅防音室A・B共通チケット 6時間',  6,  7700, 180, 1, 10),
  ('tkp-meieki-ab-12', '名駅防音室A・B共通チケット 12時間', 12, 15400, 180, 1, 11),
  ('tkp-meieki-ab-19', '名駅防音室A・B共通チケット 19時間', 19, 23100, 180, 1, 12),
  ('tkp-meieki-ab-26', '名駅防音室A・B共通チケット 26時間', 26, 30800, 180, 1, 13);

INSERT OR IGNORE INTO ticket_product_spaces (product_id, space_id) VALUES
  ('tkp-meieki-ab-6',  'meieki-piano-a'), ('tkp-meieki-ab-6',  'meieki-piano-b'),
  ('tkp-meieki-ab-12', 'meieki-piano-a'), ('tkp-meieki-ab-12', 'meieki-piano-b'),
  ('tkp-meieki-ab-19', 'meieki-piano-a'), ('tkp-meieki-ab-19', 'meieki-piano-b'),
  ('tkp-meieki-ab-26', 'meieki-piano-a'), ('tkp-meieki-ab-26', 'meieki-piano-b');

-- 東別院グランドピアノ練習室チケット（対象: higashibetsuin-piano-24h）
INSERT OR REPLACE INTO ticket_products (id, name, total_hours, price, validity_days, is_active, sort_order) VALUES
  ('tkp-higashi-6',  '東別院グランドピアノ練習室チケット 6時間',  6,  8250, 180, 1, 20),
  ('tkp-higashi-12', '東別院グランドピアノ練習室チケット 12時間', 12, 1650, 180, 1, 21),
  ('tkp-higashi-19', '東別院グランドピアノ練習室チケット 19時間', 19, 24750, 180, 1, 22),
  ('tkp-higashi-26', '東別院グランドピアノ練習室チケット 26時間', 26, 33000, 180, 1, 23);

INSERT OR IGNORE INTO ticket_product_spaces (product_id, space_id) VALUES
  ('tkp-higashi-6',  'higashibetsuin-piano-24h'),
  ('tkp-higashi-12', 'higashibetsuin-piano-24h'),
  ('tkp-higashi-19', 'higashibetsuin-piano-24h'),
  ('tkp-higashi-26', 'higashibetsuin-piano-24h');
