-- 空き状況ページ（/availability/）の各行に表示する部屋サムネイル画像URL（#74拡張）
-- 管理画面のスペース設定から画像URLを貼り付けて設定する。NULL=画像なし（プレースホルダ表示）。
ALTER TABLE spaces ADD COLUMN image_url TEXT;
