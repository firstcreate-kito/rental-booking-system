-- 0034: パスワードレスログイン（マジックリンク／6桁コード）用のチャレンジ
--
-- メールアドレスだけでログインできるようにする。
--  kind='link' … マイページ用。secret は長いトークン（URLに埋め込む）
--  kind='code' … 予約フロー/見学フォーム用。secret は6桁コード（同じ画面で入力）
-- 未登録メールはログイン成立時にその場で会員登録も兼ねる。
CREATE TABLE login_challenges (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  secret      TEXT NOT NULL,               -- link=長いトークン / code=6桁
  kind        TEXT NOT NULL,               -- 'link' / 'code'
  expires_at  TEXT NOT NULL,               -- 有効期限（JST）
  used        INTEGER NOT NULL DEFAULT 0,  -- 1=使用済み
  attempts    INTEGER NOT NULL DEFAULT 0,  -- コード誤入力の試行回数（総当たり防止）
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_login_challenges_secret ON login_challenges(secret);
CREATE INDEX idx_login_challenges_email ON login_challenges(email);
