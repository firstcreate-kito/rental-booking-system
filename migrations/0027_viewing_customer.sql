-- #81 見学申込に会員IDを紐づけ（ログイン済み会員からの申込を管理画面で識別するため）
ALTER TABLE viewing_requests ADD COLUMN customer_id TEXT;
