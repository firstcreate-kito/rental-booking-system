-- =============================================================================
-- 0037 pending_tickets（付与待ちチケット）#82 既存チケットの移行
-- 公開前の既存チケット保有者を、メール一致で会員へ自動付与するための受け皿。
-- 会員が同じメールで登録／ログイン（マイページ表示）した時点で、tickets へ発行し
-- claimed_at / claimed_customer_id / claimed_ticket_id を記録する（idempotent）。
-- =============================================================================
CREATE TABLE pending_tickets (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL,           -- 小文字で保存（照合キー）
  name                TEXT,                    -- 参考（元データの氏名）
  scope               TEXT NOT NULL,           -- 'ab'（名駅防音室A/B共通）/ 'higashibetsuin'（東別院）
  remaining_hours     INTEGER NOT NULL,        -- 残時間（1回=1時間で換算済み）
  valid_until         TEXT NOT NULL,           -- 有効期限 'YYYY-MM-DD'
  legacy_code         TEXT,                    -- 旧チケットコード（参考）
  note                TEXT,                    -- 備考
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at          TEXT,                    -- 付与済み日時（NULL=未付与）
  claimed_customer_id TEXT REFERENCES customers(id),
  claimed_ticket_id   TEXT REFERENCES tickets(id)
);

-- メール照合を高速化（未付与の検索が中心）
CREATE INDEX idx_pending_tickets_email ON pending_tickets(email);
