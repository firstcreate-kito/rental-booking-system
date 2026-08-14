-- 0008 チケットのオンライン購入履歴（Stripe Checkout）#24
-- カード決済は Stripe がホストする決済ページで行い、当システムはカード情報を保持しない。
-- 決済完了の Webhook（署名検証済み）を受けて、対象商品のチケットを顧客へ発行する。
CREATE TABLE ticket_purchases (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  product_id        TEXT REFERENCES ticket_products(id),
  stripe_session_id TEXT UNIQUE,               -- Stripe Checkout Session ID（冪等キー）
  amount            INTEGER NOT NULL,           -- 決済金額（円・税込）
  currency          TEXT NOT NULL DEFAULT 'jpy',
  status            TEXT NOT NULL DEFAULT 'pending', -- 'pending'/'processing'/'paid'/'canceled'
  ticket_id         TEXT REFERENCES tickets(id),     -- 発行したチケット（paid 時）
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at           TEXT
);

CREATE INDEX idx_ticket_purchases_customer ON ticket_purchases(customer_id, created_at);
