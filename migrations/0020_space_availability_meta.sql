-- 0020 空き状況ページ（/availability/）用のスペース・メタデータ（#74）
-- エリア／用途／同型グループ／当日締切（開始の何時間前まで）／当日タブ並び順を追加。
ALTER TABLE spaces ADD COLUMN area TEXT;                       -- meieki/sakae/naka/chikusa/other
ALTER TABLE spaces ADD COLUMN use_category TEXT;               -- piano/photo/event/storage（カンマ区切り可）
ALTER TABLE spaces ADD COLUMN room_group TEXT;                 -- 同型グループID（例 meieki-piano）
ALTER TABLE spaces ADD COLUMN same_day_cutoff_hours INTEGER NOT NULL DEFAULT 1; -- 当日は開始のN時間前まで受付
ALTER TABLE spaces ADD COLUMN same_day_priority INTEGER NOT NULL DEFAULT 100;   -- 「今日」タブの並び（小さいほど上）

-- 既存9施設のメタ初期値（本番はここで投入。管理画面から後で調整可）
UPDATE spaces SET area='sakae',   use_category='event',        same_day_priority=8  WHERE id='albe-hall-nagoya';
UPDATE spaces SET area='sakae',   use_category='event',        same_day_priority=7  WHERE id='albe-event-sakae';
UPDATE spaces SET area='meieki',  use_category='event,photo',  same_day_priority=5  WHERE id='meieki-free';
UPDATE spaces SET area='meieki',  use_category='photo',        same_day_priority=4  WHERE id='meieki-exercise';
UPDATE spaces SET area='meieki',  use_category='event,photo',  same_day_priority=6  WHERE id='meieki-washitsu';
UPDATE spaces SET area='meieki',  use_category='piano', room_group='meieki-piano', same_day_priority=1 WHERE id='meieki-piano-a';
UPDATE spaces SET area='meieki',  use_category='piano', room_group='meieki-piano', same_day_priority=1 WHERE id='meieki-piano-b';
UPDATE spaces SET area='naka',    use_category='piano,photo',  same_day_priority=3  WHERE id='higashibetsuin-piano-24h';
UPDATE spaces SET area='other',   use_category='storage,photo',same_day_priority=9  WHERE id='kitaokazaki-warehouse';
