-- 会員パスワード再発行（#21）
-- パスワード再設定トークン。メールで送るリンクに含める使い捨てトークン。
CREATE TABLE password_reset_tokens (
  token       TEXT PRIMARY KEY,               -- ランダムなトークン（URLに埋め込む）
  customer_id TEXT NOT NULL REFERENCES customers(id),
  expires_at  TEXT NOT NULL,                  -- 有効期限（JST）
  used        INTEGER NOT NULL DEFAULT 0,     -- 1=使用済み
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_prt_customer ON password_reset_tokens(customer_id);
CREATE INDEX idx_prt_expires ON password_reset_tokens(expires_at);
