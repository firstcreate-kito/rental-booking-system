-- スペース別の支払い方法プリセット（3モード）#67
--   card_only         … カード（Stripe）＋PayPal のみ（コンビニ・振込なし・直前まで可）
--   card_bank         … ＋銀行振込（Stripe収納代行）。振込は利用5日前で非表示
--   card_konbini_bank … ＋コンビニ払い。コンビニ・振込とも利用5日前で非表示
ALTER TABLE spaces ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'card_bank';

-- 既存スペースは現状の挙動を維持して移行：
--   銀行振込ON（allow_invoice=1）→ card_bank（②）／ OFF → card_only（①）
UPDATE spaces SET payment_mode = CASE WHEN allow_invoice = 1 THEN 'card_bank' ELSE 'card_only' END;

-- カード・PayPal は全モード共通でON（#67の決定）
UPDATE spaces SET allow_card = 1, allow_paypal = 1;
