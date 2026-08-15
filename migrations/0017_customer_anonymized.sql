-- 0017 データ保持ポリシー（#57）: 個人情報の匿名化フラグ
-- anonymized_at に日時が入っている顧客は「匿名化済み」。冪等処理の目印にする。
-- 匿名化は 7年（最終利用日 or 登録日から）経過し、未来の有効予約が無い顧客が対象。
-- ブラックリスト（is_blocked=1）はブロック維持のため対象外とする（アプリ側で除外）。
ALTER TABLE customers ADD COLUMN anonymized_at TEXT;
