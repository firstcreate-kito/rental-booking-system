-- 予約変更リクエストの承認ワークフロー（#54）
-- お客様がマイページから希望する変更内容（日時など）を構造化して保存する。
ALTER TABLE change_requests ADD COLUMN proposed_items TEXT;  -- JSON: [{date,startTime,endTime}]（reschedule時）
ALTER TABLE change_requests ADD COLUMN resolution TEXT;      -- 'approved' / 'rejected' / 'handled'（対応結果）
ALTER TABLE change_requests ADD COLUMN admin_note TEXT;      -- 却下理由など、管理者からの一言（お客様通知に使用）
