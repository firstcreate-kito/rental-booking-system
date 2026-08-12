-- =============================================================================
-- 変更リクエスト（セルフ操作不可時にフォームから送信される変更依頼）
-- 仕様 5.7 / API /api/bookings/:id/change-request, /api/admin/change-requests
-- =============================================================================
CREATE TABLE change_requests (
  id          TEXT PRIMARY KEY,
  group_id    TEXT REFERENCES booking_groups(id),
  customer_id TEXT,
  booking_number TEXT,
  type        TEXT NOT NULL,        -- 'reschedule' / 'option' / 'cancel' / 'other'
  message     TEXT NOT NULL,
  contact     TEXT,                 -- 連絡先(任意)
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' / 'handled'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  handled_at  TEXT,
  handled_by  TEXT
);

CREATE INDEX idx_change_requests_status ON change_requests(status);
CREATE INDEX idx_change_requests_group  ON change_requests(group_id);
