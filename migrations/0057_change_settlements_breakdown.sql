-- 0057: 精算待ちに「計算式（内訳）」を保存する列を追加。
--
-- 申込時（POST /cancel・/reschedule）にお客様へ提示した計算式（settlement-formula）を
-- 保存しておき、管理者「承認」時の顧客向け確定メールでも同じ計算式を再利用するため。
-- 承認時に管理者が金額を修正した場合は、この保存値は使わず「担当者が調整」した旨を出す。

ALTER TABLE change_settlements ADD COLUMN breakdown TEXT;
