-- 0023 変更・キャンセルポリシーのシステム化（#76 Phase 1）
--   変更・キャンセルの可否判定は「当初予約」を基準にする。
--   ・original_total_amount … 当初予約金額（作成時の合計・税込）。以後の変更で書き換えない。
--   ・original_date          … 当初利用日（複数日予約はグループ内で最も早い日）。以後の変更で書き換えない。
--   減額の累計判定（変更後金額 ÷ 当初金額）と、日数判定（当初利用日 − 本日）の基準になる。
ALTER TABLE booking_groups ADD COLUMN original_total_amount INTEGER;
ALTER TABLE booking_groups ADD COLUMN original_date TEXT;

-- 既存データのバックフィル（当初＝現在とみなす）
UPDATE booking_groups
   SET original_total_amount = total_amount
 WHERE original_total_amount IS NULL;

UPDATE booking_groups
   SET original_date = (
     SELECT MIN(b.date) FROM bookings b WHERE b.group_id = booking_groups.id
   )
 WHERE original_date IS NULL;
