-- 0056: 変更・キャンセルの「精算待ち」テーブル（統一ポリシー Phase B）
--
-- 設計（docs/unified-change-cancel-policy.md §5）：
--   お客様の申込＝枠は即時反映（変更＝新枠へ移動／キャンセル＝枠解放）。
--   お金（返金/追加請求）は本テーブルに "精算待ち(pending)" として記録し、
--   管理者が金額を確認・任意調整して「承認」すると確定・実行される。
--   ＝予約自体は confirmed/cancelled のまま。お金だけを本テーブルで承認管理する。

CREATE TABLE change_settlements (
  id             TEXT PRIMARY KEY,
  group_id       TEXT NOT NULL REFERENCES booking_groups(id),
  booking_number TEXT,
  customer_id    TEXT,
  space_id       TEXT,
  type           TEXT NOT NULL,               -- 'reschedule' | 'cancel'
  kind           TEXT NOT NULL,               -- 'move'|'increase'|'decrease'|'cancel_treatment'|'cancel'
  direction      TEXT NOT NULL,               -- 'refund' | 'charge' | 'none'
  quoted_amount  INTEGER NOT NULL DEFAULT 0,  -- 顧客に提示した金額（返金 or 請求の絶対値・円）
  final_amount   INTEGER,                     -- 管理者が承認時に確定した金額（未承認は NULL）
  payment_method TEXT,                        -- 元の支払い方法 'card'|'paypal'|'bank'|'konbini'|'ticket'|'none'
  old_items      TEXT,                        -- 変更前の日時（JSON）
  new_items      TEXT,                        -- 変更後の日時（JSON・cancel は NULL）
  note           TEXT,                        -- 自動計算の補足（ポリシー説明）
  status         TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'approved'|'dismissed'
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  resolved_by    TEXT
);

CREATE INDEX idx_change_settlements_status ON change_settlements(status);
CREATE INDEX idx_change_settlements_group  ON change_settlements(group_id);
