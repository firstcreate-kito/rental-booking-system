-- スペースごとの Google 口コミ投稿URL（Googleマイビジネスはスペース単位で作成されており
-- 口コミ投稿URLも施設ごとに異なるため、スペース単位で保持する）。
-- 利用後のお礼メール（#53）に「口コミ投稿のお願い」ボタンとして差し込む。空欄=差し込みなし。
ALTER TABLE spaces ADD COLUMN google_review_url TEXT;
