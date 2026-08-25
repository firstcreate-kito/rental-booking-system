-- 0038: 「1日料金のみ」課金（#18）
-- 目的:
--   ① 土日祝は時間料金を出さず常に1日料金にする（スペース単位のフラグ）。
--      例: アルベホール名古屋。複数日利用が多く、土日祝は入退時刻に関わらず1日料金。
--   ② GW・その谷間など「平日でも1日料金のみ」にしたい期間を指定できるようにする。
--      既存の季節料金（seasonal_pricing）＝期間＋対象スペース紐付け（seasonal_spaces）を
--      そのまま流用し、フラグ1個だけ足す（新テーブル・新画面を増やさない）。
--
-- 後方互換: 既定は両方 0（OFF）。既存スペース・既存季節料金の金額計算は一切変わらない。

ALTER TABLE spaces          ADD COLUMN weekend_day_rate_only BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE seasonal_pricing ADD COLUMN day_rate_only        BOOLEAN NOT NULL DEFAULT 0;
