-- 0021 名駅防音室A/Bを1件に集約しない（#74 指示訂正）
-- 空き状況ページでA・Bを明確に別行で表示するため、room_group を解除する。
-- （0020が適用済み/未適用のどちらでも最終状態が NULL になるよう UPDATE で対応）
UPDATE spaces SET room_group = NULL WHERE id IN ('meieki-piano-a', 'meieki-piano-b');
-- 「今日」タブでAが上・Bが下に安定して並ぶよう並び順を分ける
UPDATE spaces SET same_day_priority = 1 WHERE id = 'meieki-piano-a';
UPDATE spaces SET same_day_priority = 2 WHERE id = 'meieki-piano-b';
