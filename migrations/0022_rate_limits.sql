-- 0022 汎用レート制限（#75 ゲスト本人確認の総当たり対策）
-- key ごとに、window_start（epoch ms）からの一定時間内の試行回数を数える。
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL   -- epoch milliseconds
);
