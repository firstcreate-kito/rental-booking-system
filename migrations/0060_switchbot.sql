-- SwitchBotロック連携（スペース別・A案＝「解錠のみ」／施錠は自動で行わない）。
-- unlock_mode: off=無効 / auto=利用開始時刻に自動解錠 / button=お客様が解錠ボタンで解錠 / passcode=暗証番号（Keypad・将来対応）
ALTER TABLE spaces ADD COLUMN switchbot_unlock_mode TEXT NOT NULL DEFAULT 'off';
-- SwitchBotロック本体の deviceId（auto/button で使用）
ALTER TABLE spaces ADD COLUMN switchbot_lock_device_id TEXT;
-- SwitchBot Keypad の deviceId（passcode 方式・将来対応）
ALTER TABLE spaces ADD COLUMN switchbot_keypad_device_id TEXT;
-- 利用開始の何分前に解錠するか（auto/button の前倒し許容）
ALTER TABLE spaces ADD COLUMN switchbot_unlock_lead_min INTEGER NOT NULL DEFAULT 5;

-- 解錠の実行ログ（監査・重複防止・管理画面表示）
CREATE TABLE IF NOT EXISTS switchbot_unlock_log (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,          -- 実行日時（JST）
  space_id TEXT,                     -- 対象スペース
  booking_group_id TEXT,             -- 対象予約グループ（管理者テストは NULL 可）
  booking_number TEXT,
  slot_key TEXT,                     -- 'YYYY-MM-DD HH:MM'（自動解錠の重複防止キー）
  device_id TEXT,                    -- 解錠したロックの deviceId
  trigger TEXT,                      -- 'auto' | 'button' | 'admin_test'
  status TEXT,                       -- 'success' | 'failed' | 'skipped'
  detail TEXT                        -- 補足（エラー内容など）
);
CREATE INDEX IF NOT EXISTS idx_sbunlock_group ON switchbot_unlock_log(booking_group_id);
CREATE INDEX IF NOT EXISTS idx_sbunlock_created ON switchbot_unlock_log(created_at);
CREATE INDEX IF NOT EXISTS idx_sbunlock_slot ON switchbot_unlock_log(booking_group_id, slot_key, status);
