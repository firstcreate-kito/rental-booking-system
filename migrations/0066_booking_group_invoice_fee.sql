-- 請求書払い（手動・自社口座／Stripe非経由）の発行手数料。
-- 手動請求書払いを選んだ予約にのみ ¥500 を記録する（銀行振込＝Stripe収納代行は無料）。
-- 方針：スペース料金＋オプションの合計(total_amount)は従来のまま据え置き、この手数料は
--   別カラムで管理する。これにより、キャンセル料・返金・差額計算(total_amount基準)は一切
--   変わらず、¥500は非返金・キャンセル料の対象外として扱える。請求金額（お客様が支払う額）
--   ＝ total_amount + invoice_fee として、請求書・領収書・確認メール・管理画面で加算表示する。
ALTER TABLE booking_groups ADD COLUMN invoice_fee INTEGER NOT NULL DEFAULT 0;
