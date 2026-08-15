-- 事業者情報（請求書・領収書の発行元）#41
-- レンタルスペールALBE 運営会社：株式会社ファーストクリエイト
-- ※請求書・領収書に印字される。振込先はお客様に開示する情報（機密ではない）。
INSERT OR REPLACE INTO system_settings (key, value) VALUES
  ('issuer_name', 'レンタルスペースALBE（株式会社ファーストクリエイト）'),
  ('issuer_zip', ''),
  ('issuer_address', '名古屋市中村区名駅南1-3-14 石原ビル4F'),
  ('issuer_tel', '052-485-5975'),
  ('issuer_email', 'rental@space-albe.com'),
  ('issuer_invoice_reg_no', 'T5180001121351'),
  ('issuer_bank_info', '口座名義：カ）ファーストクリエイト
三菱UFJ銀行 柳橋支店 普通 0222827
ゆうちょ銀行 店番208 普通 1293209'),
  ('issuer_note', '※お振込手数料はお客様のご負担にてお願いいたします。');
