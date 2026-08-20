-- #81 見学申込：カレンダー非参照スペース（見学のみ・空き確認なし）
-- 予約システムのカレンダー(spaces)では管理しない施設。見学申込の「見学希望のスペース」に
-- 選択肢として出し、選ばれた場合は空き確認をスキップして希望日時をそのまま受け付ける。

CREATE TABLE IF NOT EXISTS viewing_extra_spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO viewing_extra_spaces (id, name, sort_order) VALUES
  ('vx-shinsakae',                '新栄スペース',                 10),
  ('vx-chikusa-photo-studio',     '千種区撮影スタジオ',           20),
  ('vx-chiyoda-shirohori',        '千代田白ホリスペース',         30),
  ('vx-chikusa-haikyo-studio',    '千種区廃墟スタジオ',           40),
  ('vx-chikusa-recording-studio', '千種区レコーディングスタジオ', 50),
  ('vx-chiyoda-washitsu',         '千代田和室スペース',           60),
  ('vx-sakae-chapel',             '栄チャペルスペース',           70),
  ('vx-sakae-shinden',            '栄神殿スペース',               80),
  ('vx-toyohashi-chapel',         '豊橋駅前チャペルスペース',     90),
  ('vx-inazawa-house-studio',     '稲沢ハウススタジオ',          100);
