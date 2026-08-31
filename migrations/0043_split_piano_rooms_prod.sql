-- 0043 名駅防音室グランドピアノ練習室 A/B を空き状況ページで別行表示する（本番反映）
-- 0021 で room_group を NULL 化したが、その後の seed 再投入等で本番に room_group='meiek-piano'
-- が残り A・B が1行にまとまっていた。履歴に依存せず確実に分割するため、対象2室の
-- room_group を改めて NULL に戻す（冪等・空き状況ページの行まとめだけに影響）。
UPDATE spaces SET room_group = NULL WHERE id IN ('meieki-piano-a', 'meieki-piano-b');
-- 「今日」タブで A が上・B が下に安定して並ぶよう並び順を明示（他日は sort_order 準拠）。
UPDATE spaces SET same_day_priority = 1 WHERE id = 'meieki-piano-a';
UPDATE spaces SET same_day_priority = 2 WHERE id = 'meieki-piano-b';
