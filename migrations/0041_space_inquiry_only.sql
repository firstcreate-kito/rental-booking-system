-- 0041 スペースに「申込はお問い合わせのみ」モードを追加。
-- ON のスペースは、空き状況カレンダーは今までどおり ○/△/× を表示するが、
-- 日程をクリックしても時間選択に進まず、お問い合わせフォームへ誘導する（予約フォーム非公開の施設向け）。
-- 既定 OFF（従来どおり予約可）。
ALTER TABLE spaces ADD COLUMN inquiry_only INTEGER NOT NULL DEFAULT 0;
