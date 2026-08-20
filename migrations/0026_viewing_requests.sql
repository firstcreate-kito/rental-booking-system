-- #81 見学申込（viewing requests）
-- 予約とは別種別。無料・決済なし・所要30分・Googleカレンダー非反映（記録のみ）。
-- 申請制：お客様申込 → 自動受付 → スタッフが管理画面で確定/提案/お断り。

CREATE TABLE IF NOT EXISTS viewing_requests (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,                       -- 'slot'（空き枠選択） | 'propose'（希望時期→提案）
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  org_name TEXT,                            -- 会社名・学校名・団体名（任意）
  purpose TEXT NOT NULL,                    -- 利用目的（予約フォームと同じ選択肢）
  booking_status TEXT NOT NULL,            -- 現在の予約状況: 'booked'|'considering'|'other'
  -- モードA（slot）: 第一・第二希望（各 日付＋開始時刻。所要30分固定）
  first_date TEXT,
  first_start TEXT,
  second_date TEXT,
  second_start TEXT,
  -- モードB（propose）: おおよその希望時期＋任意の傾向
  desired_period TEXT,                      -- 例：来週の平日午後
  pref_daytype TEXT,                        -- 任意: 'any'|'weekday'|'weekend'
  pref_timeband TEXT,                       -- 任意: 'any'|'morning'|'afternoon'|'evening'
  note TEXT,                                -- ご質問・ご要望（自由記入・任意）
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|proposed|confirmed|declined|cancelled
  -- スタッフが設定する確定/提案日時（所要30分）
  confirmed_date TEXT,
  confirmed_start TEXT,
  confirmed_end TEXT,
  staff_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_viewing_requests_status ON viewing_requests(status, created_at);

-- 1申込＝複数施設（複合選択）を正しく保持する子テーブル
CREATE TABLE IF NOT EXISTS viewing_request_spaces (
  request_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  PRIMARY KEY (request_id, space_id)
);

CREATE INDEX IF NOT EXISTS idx_viewing_request_spaces_req ON viewing_request_spaces(request_id);
