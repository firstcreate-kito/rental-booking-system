# 統合公開手順書 — 公式サイト × 予約システム（当日の1枚）

- **目的**: 公式サイト（space-albe.com）と予約システム（booking.space-albe.com）は**別々の2システム**。
  それぞれに公開手順があるが、**噛み合う箇所があるため順序を1本に束ねる**。当日はこの1枚を上から実行する。
- **詳細の出典**:
  - 予約システム側 … `docs/go-live-checklist.md`（当日作業）＋ `docs/launch-cutover-plan.md` 8章（Bookly移行の分岐と復旧）
  - 公式サイト側 … 別途「公開の手順書（albe-launch-runbook）」＝ConoHa/WordPress上書き・`.htaccess`・`deploy-conoha.yml`
- 凡例：🌐=公式サイト側　🎟=予約システム側　🧑‍💻=運用者操作　🤖=Claude支援

---

## 0. 全体像：2システム・2枚のカーテン

| | 公式サイト 🌐 | 予約システム 🎟 |
|---|---|---|
| 実体 | 静的92ページ（ConoHa・WordPressを上書き） | Cloudflare Worker `albe-booking-api` |
| 反映 | `main` へ push → `deploy-conoha.yml` 自動 | GitHub Actions「Deploy」staging→production |
| **カーテン（隠す仕組み）** | `/` のメンテ告知（503） | **Basic認証ゲート**（`BASIC_AUTH_USER`/`PASS`） |
| **開ける瞬間（最後の1手）** | `.htaccess` 書換（`DirectoryIndex`） | `BASIC_AUTH_*` を削除 |
| 戻し方 | `.htaccess` の該当行を消す（配布92ページは自動削除されない） | ゲートを再設定／移行はロールバック→再取り込み |

> **両システムとも「カーテンを閉じたまま中身を差し替え、最後にカーテンを開く」**設計。
> この性質を活かし、**危険で不可逆な作業（Bookly切断・移行）を先に済ませて確認し、公開の瞬間は最後に集約する。**

---

## 1. 連動の勘所（ここだけ外さない）

1. **予約システムの公開は、公式サイトのカーテンを開ける“前”に完了させる。**
   サイトのトップを開くと一般客が「予約」ボタン経由で booking.space-albe.com に流れ込む。
   その時に予約システムが**公開済み・移行済み**でなければならない。→ **開ける順は「予約 → サイト」**。
2. **お問い合わせ**：サイト `/contact/` は予約APIの `POST /api/contact` に送信。
   `/api/contact` は**認証ゲートを常時バイパス**するので、**予約ゲートの開閉に関係なく動く**（サイト側の送信テストはいつでも可）。
3. **Bookly新規受付の停止**：サイト配置で `/chenge-reservation/` 等のBooklyフォームは上書きされるが、
   深いURLは残り得るため、**Bookly側でも明示的に新規受付を停止**してから切断する。
4. **予約リンクの導通**：サイトの各施設ページ→予約システムのディープリンクが正しいことを、サイト確認時に click-through で確認。
5. **未来のBookly予約の扱い**：予約システム側の移行ツールが**新システムの予定＋本予約枠として取り込む**（サイトrunbookの「これから来る予約」の答え）。
   ただし移行分は `customer_id=NULL`＝**会員に紐付かず、お客様は自分で変更・キャンセルできない**（§5 未決事項）。

---

## 2. 前日まで（両側の準備・落ち着いてできる）

### 2-A. 予約システム 🎟（`go-live-checklist.md` A章）
- [ ] 本番決済鍵（「Production secrets」`YES-PRODUCTION`）／Stripe本番Webhook／`GOOGLE_SA_*`（管理画面で Google連携=有効）
- [ ] 事業者情報・振込口座（#92）・8スペース設定の最終確認
- [ ] 最新CSVで `bookly-slots.json` 再生成 → staging→production デプロイ／DBマイグレーション本番適用
- [ ] 🤖 復旧リハーサル緑：`npx vitest run test/bookly-recovery-drill.test.ts`
- [ ] ステージング予行（名駅フリー・テストカレンダー）／**OTA両方向テスト（GO/NO-GO）**

### 2-B. 公式サイト 🌐（サイトrunbook 前提）
- [ ] 公開前チェック §L（L1〜L4）解決済み
- [ ] stg でお問い合わせ送信→完了ページ実測（＝予約API `/api/contact` 導通）
- [ ] 作業ブランチ push 済み・直近ステージング反映が成功
- [ ] Bookly予約データを書き出し済み（WordPressを消すなら必須・不可逆）
- [ ] **メンテ告知が出ている**（`/` に告知、`/info/` が200）
- [ ] 手元で通す：`sh tools/build-all.sh` / `node tools/check-en-parity.mjs`（要対応0）/ `node tools/check-space-ids.mjs`

---

## 3. 当日（メンテ枠・上から順に）

> 原則：**危険で不可逆な予約システムのBookly移行を先に完了・確認 → 公式サイトを配置・確認 → 最後に2枚のカーテンを続けて開く。**

### フェーズ1：予約システムの移行（ゲートは閉じたまま）🎟
1. [ ] **【保険】バックアップ**：各スペースGoogleカレンダーを `.ics`＋Bookly予約CSV（最新）。
2. [ ] **本番カレンダー接続**：8スペースの `google_calendar_id`＝既存本番カレンダー→接続テスト。**新規カレンダーは作らない**。
3. [ ] **Bookly新規受付を停止**（Bookly側・§1-3）。
4. [ ] **Bookly切断** → 「OTAは残る／Bookly由来は消える」を確認（分岐の詳細＝`launch-cutover-plan.md` 8-0）。
5. [ ] **Bookly予約 本番取り込み**：管理画面→「Bookly予約の移行」→全スペース→プレビュー→実行（`remaining=0` まで）。
6. [ ] **チケット移行（#82）**：Actions「ticket-migration」（`docs/ticket-migration.md`）。
7. [ ] **目視GO/NO-GO**：既知予約・空き状況・サイネージ本文（平日/土日祝・`[スペース名]`）。
   - ここまで予約システムは**まだBasic認証ゲート内**＝一般客に見えない。問題があれば §4 で戻す。

### フェーズ2：公式サイトの配置（トップのカーテンは閉じたまま）🌐
8. [ ] **`main` にマージ→push**（`deploy-conoha.yml` 自動反映）。**必ず `main` 経由**。`--delete` は使わない（現行ファイルは消えない＝戻せる）。
9. [ ] ここで **92ページが本番に配置**。`/introduce/…` `/contact/` `/en/…` は**新サイトに切替**、**`/` はまだ告知**、記事・`/wp-admin/` は従来どおり。
10. [ ] **確認（カーテン閉のうち・実機で目視）**：`/introduce/sakae-chapel/` `/en/` `/contact/` `/robots.txt`（Sitemap行）`/sitemap.xml`（83件）`/2026/01/25/nagoya-piano/`（WP記事生存）`/wp-admin/` `/info/`。
11. [ ] **お問い合わせを1件テスト送信**（→ `/api/contact`）。担当者宛・お客様控えのメール文面を確認（連携仕様 §7）。
12. [ ] **予約リンクの click-through 確認**：施設ページ→ booking.space-albe.com（この時点は運用者がBasic認証で開ける）。**問題あればここで止める**（トップは告知のままなので客に見えない）。

### フェーズ3：公開の瞬間（2手・続けて）
13. [ ] 🎟 **予約システムのゲート解除**：本番Workerの `BASIC_AUTH_USER`／`BASIC_AUTH_PASS` を削除（Cloudflareダッシュボード or `wrangler secret delete`）。
14. [ ] 🎟 **予約スモークテスト**（公開状態で）：ログインなしで開く／本番テスト予約1件（少額 or 返金）→決済・Google予定・メール・Webhook 2xx・領収書PDF。
15. [ ] 🌐 **公式サイトのカーテンを開ける**：`public_html/space-albe.com/.htaccess` で
    - ① メンテ告知の囲み（`# BEGIN 〜 # END メンテナンス告知`）を**削除**
    - ② `# BEGIN WordPress` より上に `DirectoryIndex index.html index.php` を**追記**（無いとトップがWordPressのまま）
16. [ ] 🌐 **すぐ確認＋ConoHaコンテンツキャッシュ削除**：`/`（新トップ）`/en/` `/info/`（まだ200）記事URL。

### フェーズ4：後始末
17. [ ] 🌐 `/info/` を削除（フォルダごと・`noindex`）／Search Console に `sitemap.xml` 送信／GA計測確認。
18. [ ] 🎟 Bookly は**アンインストールせず無効化のみ**で猶予保持（旧予定がGoogleに残ることを確認、未来予約消化後に撤去検討）。
19. [ ] 🎟 移行分の変更対応窓口を運用へ周知（§5）。

---

## 4. 戻すとき（段階別・両システム）

| 段階 | 公式サイト 🌐 | 予約システム 🎟 |
|---|---|---|
| フェーズ2まで（サイト配置前） | 何もしなくてよい（`/`告知のまま） | ゲート内。移行に不備→「取り消し（ロールバック）」→再取り込み |
| サイト配置後・カーテン開く前 | `.htaccess` は未変更なのでトップは告知。個別ページは配布済み（害なし） | 同上 |
| **切断で新システム予定まで消えた（パターンB）** | — | **ロールバック→再取り込み**で完全復元（`launch-cutover-plan.md` 7-4・実証済み） |
| カーテンを開けた後 | `.htaccess` の `DirectoryIndex` 行を消す→トップだけWordPressに戻る。全部戻すなら配布92ページを手で削除 | `BASIC_AUTH_*` を再設定すればゲート復活 |
| OTA枠が空きに戻った | — | OTAチャネル同期の自己復旧を待つ（`.ics`手動復元はOTAに使わない） |

**鉄則**：フェーズ2の確認（手順10〜12）を飛ばさない。戻すのが最も重いのは「配って・カーテンを開けた後」。

---

## 5. 触らないもの / 未決事項

### 触らないもの
- 🌐 `/wp-content/uploads/`（新サイト画像221本の実体）、ブログ記事URL（移行はmicroCMS・完了まで据置）、`wp-admin`/`wp-*.php` 等（転送除外）。
- 🎟 新規Googleカレンダーを作らない／OTA予約を新システムD1で変更・キャンセルしない／Booklyをアンインストールしない。

### 未決事項（公開までに方針決定）
1. **移行したBooklyのお客様の自己変更**：移行分は `customer_id=NULL`＋新採番のため、**お客様はマイページ／ゲスト変更で自分の予約を操作できない**。
   → 選択肢：(a) 個別にご連絡し変更は運用者が代行、(b) 主要顧客のみ会員紐付け、(c) そのまま半年で自然消化。**要決定**。
2. **本番を Cloudflare プロキシに通すか**（サイトrunbook L8）：通すなら事前に `AI Crawl Control → Managed robots.txt` を切る（`Sitemap:` 行が消える／方針反転を防ぐ）。
   ※予約システム（booking.space-albe.com）は既にCloudflare Worker。**公式サイトをプロキシ化する場合の話**。

---

## 6. クイック順序（暗記用）

```
前日: [🎟本番鍵/Webhook/カレンダー鍵/CSV再生成/デプロイ/リハーサル/OTA両方向] [🌐§L/stg contact/告知/build通す]
当日:
  1) 🎟 バックアップ → カレンダー接続 → Bookly受付停止 → 切断 → 取り込み → チケット移行 → 目視GO/NO-GO   （ゲート閉のまま）
  2) 🌐 main push（92ページ配置・/はまだ告知）→ 個別ページ確認 → contactテスト送信 → 予約リンク導通
  3) 🎟 ゲート解除 → 予約スモークテスト
  4) 🌐 .htaccess でカーテンを開ける → 確認＋キャッシュ削除
  5) 後始末: 🌐 /info削除・sitemap送信・GA / 🎟 Bookly無効化保持・移行分の変更窓口周知
```

> 参照：`docs/go-live-checklist.md`（🎟当日詳細）｜`docs/launch-cutover-plan.md` 8章（🎟Bookly移行の分岐・復旧）｜公式サイト「公開の手順書」（🌐ConoHa/.htaccess 詳細）
