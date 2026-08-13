-- =============================================================================
-- スペースに slug（URL用の別名）を追加
-- 部屋ごとの固有URL（ディープリンク）で、id の代わりに任意のスラッグを使えるようにする。
-- NULL可（未設定なら id を使用）。非NULLは一意。
-- =============================================================================
ALTER TABLE spaces ADD COLUMN slug TEXT;

-- 非NULLのみ一意（複数NULLを許容する部分ユニークインデックス）
CREATE UNIQUE INDEX idx_spaces_slug ON spaces(slug) WHERE slug IS NOT NULL;
