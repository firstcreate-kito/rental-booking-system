-- =============================================================================
-- seeds/pending_tickets.sql  既存チケットの移行データ（#82）
-- 出典: 提供Excel Sheet2（8/30受領の最新）。1回=1時間で換算。補正済み:
--   ・8/30最新反映: 岩瀬5→4 / 嘉藤17→15 / 堀田19→17 / SHICHIAI7→5 / 蒼風なな13新規 / 石原ゆいか消化済み(削除)
--     ※末尾のreconcile節で、既に本番投入済みでも未付与(pending)行のみ最新化する（付与済みは不変）。
--   ・日下部圭子 メール firko.keiko@gmai.com → gmail.com
--   ・細田紗希 東別院 残26時間（Excel『未使用』を確認により確定）
-- 有効期限 valid_until は『公開日+1年』。投入前に __VALID_UNTIL__ を置換すること。
--   例) sed -i 's/__VALID_UNTIL__/2027-09-01/g' seeds/pending_tickets.sql
-- 実行は公開直前に本番D1へ:
--   wrangler d1 execute albe_booking --remote --file=./seeds/pending_tickets.sql
-- 再実行しても重複しないよう INSERT OR IGNORE（id固定）。
-- =============================================================================
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-001','723.ukiuki@gmail.com','内田菜摘','ab',5,'__VALID_UNTIL__','erb3','移行:AB共通　10回購入 コードerb3');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-002','cherrymusiccampus3@gmail.com','岩瀬智美','ab',4,'__VALID_UNTIL__','3kfb','移行:AB共通　4回購入 コード3kfb（8/30最新:残4）');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-003','katorapa21@gmail.com','嘉藤佑亮','higashibetsuin',15,'__VALID_UNTIL__','bx4f','移行:東別院　5回購入 コードbx4f（8/30最新:残15）');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-004','ocolor76@docomo.ne.jp','川合美保香','higashibetsuin',1,'__VALID_UNTIL__','thy5','移行:東別院　2回購入 コードthy5');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-005','moonpleasant19@gmail.com','猿丸詩摩子','higashibetsuin',3,'__VALID_UNTIL__','psb2','移行:東別院　2回購入 コードpsb2');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-006','nmmoro4@gmail.com','諸岡成人','ab',2,'__VALID_UNTIL__','k6zx','移行:AB共通　2回購入 コードk6zx');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-007','aniuy-jump-0729@softbank.ne.jp','大野由比奈','ab',11,'__VALID_UNTIL__','n5zf','移行:AB共通　10回購入 コードn5zf');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-008','masatakasakai@hotmail.com','坂井正剛','ab',7,'__VALID_UNTIL__','24ew','移行:AB共通　2回購入 コード24ew');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-009','honayu89@gmail.com','松澤穂奈美','ab',4,'__VALID_UNTIL__','v8xa','移行:AB共通　1回購入 コードv8xa');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-010','midori.260215.888@gmail.com','坂井みどり','ab',3,'__VALID_UNTIL__','avs6','移行:AB共通　1回購入 コードavs6');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-011','carillon-jun@outlook.jp','ほんだじゅんこ','ab',22,'__VALID_UNTIL__','n6vs','移行:AB共通　13回購入 コードn6vs');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-012','m2i0d0o3r0i3_y3o1shinaga@docomo.ne.jp','吉永みどり','ab',4,'__VALID_UNTIL__','7nv9','移行:AB共通　19回購入 コード7nv9');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-013','hirotoe0112@gmail.com','加藤由華','higashibetsuin',1,'__VALID_UNTIL__','f2a5','移行:東別院　2回購入 コードf2a5');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-014','absolutnie_umiec_kosuke@yahoo.co.jp','江崎皓介','ab',6,'__VALID_UNTIL__','6af7','移行:AB共通　2回購入 コード6af7');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-015','mew-ino@ezweb.ne.jp','井埜三鶴','ab',7,'__VALID_UNTIL__','5f9e','移行:AB共通　3回購入 コード5f9e');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-016','shichiai@gmail.com','SHICHIAI','ab',5,'__VALID_UNTIL__','8u9w','移行:AB共通　19回購入 コード8u9w（8/30最新:残5・本番は付与済み7hのまま許容）');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-017','akiko1206okika-st.n@ezweb.ne.jp','森實昭子','higashibetsuin',7,'__VALID_UNTIL__','m5xs','移行:東別院　1回購入 コードm5xs');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-018','s5.idm.oetm@gmail.com','山本 慎太郎','ab',5,'__VALID_UNTIL__','xhtv','移行:AB共通　6回購入 コードxhtv');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-019','k.kash@outlook.jp','嘉代航己','ab',2,'__VALID_UNTIL__','b7eb','移行:AB共通　3回購入 コードb7eb');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-020','karahama996@icloud.com','浅野友佳','ab',2,'__VALID_UNTIL__','nd3y','移行:AB共通　1回購入 コードnd3y');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-021','akina.konishi@gmail.com','小西亜季奈','ab',22,'__VALID_UNTIL__','37si','移行:AB共通　6回購入 コード37si');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-022','ns.sakanamusic@gmail.com','西健','ab',1,'__VALID_UNTIL__','sa8f','移行:AB共通　1回購入 コードsa8f');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-023','qwhks096@yahoo.co.jp','竹森樹梨','ab',2,'__VALID_UNTIL__','h2e2','移行:AB共通　1回購入 コードh2e2');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-024','hitomicocolove@gmail.com','市川ひと美','ab',2,'__VALID_UNTIL__','tmt8','移行:AB共通　1回購入 コードtmt8');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-025','chisatoitoitoi.g@gmail.com','安藤知里','ab',2,'__VALID_UNTIL__','wtt6','移行:AB共通　2回購入 コードwtt6');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-026','aug16.magic-tones@docomo.ne.jp','宇土木淳','ab',6,'__VALID_UNTIL__','34pu','移行:AB共通　3回購入 コード34pu');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-027','yurikoro.20001115@gmail.com','岩山有里','ab',2,'__VALID_UNTIL__','ja75','移行:AB共通　1回購入 コードja75');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-028','wrencon919@gmail.com','酒井昭典','ab',2,'__VALID_UNTIL__','3xwh','移行:AB共通　2回購入 コード3xwh');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-029','tomoki.flute@gmail.com','堀田智貴','ab',17,'__VALID_UNTIL__','ngb7','移行:AB共通　1回購入 コードngb7（8/30最新:残17）');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-030','capi611@gmail.com','古村志帆','ab',1,'__VALID_UNTIL__','mz6n','移行:AB共通　1回購入 コードmz6n');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-031','rochelle03a@gmail.com','原文菜','ab',7,'__VALID_UNTIL__','uub9','移行:AB共通　1回購入 コードuub9');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-032','addict20fx1@gmail.com','松本圭介','ab',2,'__VALID_UNTIL__','57da','移行:AB共通　12回購入 コード57da');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-033','moritaku060618@icloud.com','森本 琢仁','ab',2,'__VALID_UNTIL__','f8b5','移行:AB共通　1回購入 コードf8b5');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-034','naoryo1923@gmail.com','強瀬亮司','ab',4,'__VALID_UNTIL__','d5v6','移行:AB共通　1回購入 コードd5v6');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-035','xx0v0x0v0xx@yahoo.co.jp','八神瑠衣','ab',1,'__VALID_UNTIL__','2bhu','移行:AB共通　3回購入 コード2bhu');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-036','kasumikotouge@gmail.com','小峠香澄','ab',2,'__VALID_UNTIL__','gpw3','移行:AB共通　5回購入 コードgpw3');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-038','snaom.yume@gmail.com','花村紗衣','ab',3,'__VALID_UNTIL__','2vjb','移行:AB共通　1回購入 コード2vjb');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-039','firko.keiko@gmail.com','日下部　圭子','higashibetsuin',20,'__VALID_UNTIL__','sku5','移行:東別院 コードsku5');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-040','saki.hosoda27@gmail.com','細田　紗希','higashibetsuin',26,'__VALID_UNTIL__',NULL,'移行:東別院 コード未使用');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-041','fuji.ayu0113@gmail.com','藤村　あゆみ','ab',4,'__VALID_UNTIL__','7c5d','移行:AB共通 コード7c5d');
INSERT OR IGNORE INTO pending_tickets (id,email,name,scope,remaining_hours,valid_until,legacy_code,note) VALUES ('pt-042','kaguyamadoka@icloud.com','蒼風　なな','ab',13,'__VALID_UNTIL__',NULL,'移行:AB共通 8/30最新で追加（残13）');

-- =============================================================================
-- 8/30 最新チケット情報での差分反映（reconcile）。
-- 既に本番へ投入済みの pending_tickets を最新へ更新する。
-- 【重要】UPDATE/DELETE は claimed_at IS NULL（＝まだ会員に付与していない）行だけを対象にし、
-- 付与済み（会員化で発行済み）の行には一切触れない＝二重付与・過少付与を起こさない。
-- 全て冪等（何度実行しても結果は同じ）。新規環境では対象行が無く no-op。
--   ・岩瀬智美 5→4 / 嘉藤佑亮 17→15 / 堀田智貴 19→17（いずれも未付与）
--   ・SHICHIAI は付与済み(7h)につき本番は不変（真値5hは案①で許容）。未付与dup対策で防御的UPDATEのみ。
--   ・石原ゆいか 残0（消化済み）→ 未付与行を削除。
-- =============================================================================
UPDATE pending_tickets SET remaining_hours=4  WHERE email='cherrymusiccampus3@gmail.com' AND claimed_at IS NULL;
UPDATE pending_tickets SET remaining_hours=15 WHERE email='katorapa21@gmail.com'         AND claimed_at IS NULL;
UPDATE pending_tickets SET remaining_hours=17 WHERE email='tomoki.flute@gmail.com'        AND claimed_at IS NULL;
UPDATE pending_tickets SET remaining_hours=5  WHERE email='shichiai@gmail.com'            AND claimed_at IS NULL;
DELETE FROM pending_tickets WHERE email='tatami_8_jyou@yahoo.co.jp' AND claimed_at IS NULL;
