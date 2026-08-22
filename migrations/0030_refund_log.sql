-- 0030: 返金の監査証跡（誰が・いつ・いくら・どの方法で返金したか）
--
-- 返金はお金が動く操作のため、承認・実行の記録を必ず残す。
--  mode:   'stripe'（カード自動）/ 'paypal'（自動）/ 'manual'（振込・コンビニは手動）
--  status: 'done'（自動返金の実行成功）/ 'manual_pending'（手動対応の記録＝実振込は管理者）
--          / 'manual_done'（手動振込の完了を管理者が記録）
CREATE TABLE refund_log (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES booking_groups(id),
  amount       INTEGER NOT NULL,               -- 返金額（円）
  mode         TEXT NOT NULL,                  -- 'stripe' / 'paypal' / 'manual'
  status       TEXT NOT NULL,                  -- 'done' / 'manual_pending' / 'manual_done'
  provider_refund_id TEXT,                     -- Stripe/PayPal の返金ID（自動返金時）
  reason       TEXT,                           -- 理由メモ（任意）
  created_by   TEXT,                           -- 実行した管理者（email 等）
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_refund_log_group ON refund_log(group_id);
