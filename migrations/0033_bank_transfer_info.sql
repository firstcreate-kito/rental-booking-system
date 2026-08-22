-- 0033: Stripe銀行振込の振込先（仮想口座）情報を保存する
--
-- お客様に振込先口座をメール／マイページでも案内できるよう、Stripeが発行する
-- 仮想口座（銀行名・支店・口座種別・口座番号・名義）をJSONで保存する。
-- これまでは Stripe のホスト決済ページでしか表示されなかった。
ALTER TABLE booking_payments ADD COLUMN bank_transfer_info TEXT;  -- JSON: {bankName,branchName,accountType,accountNumber,accountHolderName}
