-- 0044 見学申込に「ご利用希望日（時期）」任意欄を追加
-- 見学後の“実利用”の希望日時（カレンダー指定）または「時期検討中（フリーテキスト）」を
-- 表示用の1カラムに整形して保存する（任意入力）。
ALTER TABLE viewing_requests ADD COLUMN usage_wish TEXT;
