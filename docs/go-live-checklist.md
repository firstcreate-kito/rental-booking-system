# 公開（本番オープン）チェックリスト — 当日の実地作業まとめ

- **目的**: レンタルスペースALBE 予約システムを本番公開する当日に必要な作業を、順番どおり1枚にまとめたもの。
- **コード実装は完了済み**。残るのは「鍵・設定の投入」と「Bookly/チケットの実データ移行」と「ゲート解除」という**運用作業**。
- Bookly予約移行の詳細な理屈と復旧策は `docs/launch-cutover-plan.md`（特に **8章 当日ランブック**）を参照。本書はそれも含めた**公開当日の全体台本**。
- 凡例：🧑‍💻=運用者がGitHub/各社管理画面で操作　🤖=Claudeがコード/デプロイで支援　⏱=所要目安

---

## 0. 対象環境と原則

| | 本番 | ステージング |
|---|---|---|
| Worker | `albe-booking-api` | `albe-booking-api-staging` |
| URL | https://booking.space-albe.com | https://albe-booking-api-staging.rental-space-albe.workers.dev |
| D1 | `albe_booking` | `albe_booking_staging` |

- **ステージング先行は例外なし**（CLAUDE.md）。コード変更を伴う場合は staging→確認→production。
- **公開日はメンテ枠（低トラフィック帯）で実施**。Bookly受付停止〜公開までの間は一般客が予約できない状態を保つ（未同期の窓を作らない）。

---

## A. 事前準備（T-3〜T-1・落ち着いてできる作業）

### A-1. 本番シークレットの投入 🧑‍💻
- [ ] **決済（Stripe/PayPal 本番キー）**：GitHub → Actions → **「Production secrets」** → `confirm=YES-PRODUCTION` で実行。
  - 投入対象：`STRIPE_SECRET_KEY`（sk_live）/ `STRIPE_WEBHOOK_SECRET` / `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_MODE=live`。
  - ガード：テストキー（sk_test / PAYPAL_MODE≠live）は自動で拒否される。
- [ ] **メール送信（Resend）の本番設定**：`RESEND_API_KEY` / `MAIL_FROM`（任意 `MAIL_REPLY_TO`）を本番Workerに投入し、**Resendで送信ドメイン（space-albe.com 等）を認証**する。
  - ⚠️ **これが唯一のDNS作業**：Resendが指示する **SPF（TXT）・DKIM（CNAME/TXT）**（必要なら return-path）を `space-albe.com` ゾーン（Cloudflare側）に追加。未認証だと案内・通知メールが送信拒否/迷惑メール化する。
  - ドメイン/DNSはこれ以外に操作不要：`booking.space-albe.com` は Cloudflare カスタムドメインで設定済み、公式サイトは同一ConoHa上の `.htaccess` 差し替えのみ（A/CNAME変更なし）。
- [ ] **Googleカレンダー用サービスアカウント鍵が本番Workerに入っているか確認**：`GOOGLE_SA_EMAIL` / `GOOGLE_SA_PRIVATE_KEY`。
  - 未投入なら本番Workerに設定（サービスアカウントは環境非依存＝ステージングと同じ値でよい）。
  - 確認：本番管理画面「システム状態」で **Google連携=有効** になっていること。

### A-2. 決済Webhook（本番）🧑‍💻
- [ ] Stripe本番ダッシュボードで Webhook エンドポイントを作成：`https://booking.space-albe.com/api/webhooks/stripe`。
  - 対象イベント（最低限）：`checkout.session.completed`、（コンビニ/振込を使う場合）`payment_intent.succeeded` 等。
  - 署名シークレットを `STRIPE_WEBHOOK_SECRET_PROD` としてGitHub Secretsに登録 → A-1で投入。
- [ ] コンビニ払いを使う場合の本番設定（#39）を確認。
- [ ] PayPal本番アプリのWebhook（使う場合）を設定。

### A-3. マスタ・事業者情報の最終確認 🧑‍💻
- [ ] 事業者情報（特商法表記・連絡先・振込口座）が本番の実値になっているか（**#92 銀行振込口座の実地確認**）。
- [ ] 8スペースの内容（名称・料金・営業時間・支払い方法プリセット・追加質問・閉鎖日など）を最終レビュー。
- [ ] スペース表示順（#103は任意・未対応でも公開可）。

### A-4. 移行データの準備（★2026-08-30 に最新データで再生成）🤖🧑‍💻
> **重要**：現在同梱の `bookly-slots.json`（308枠）／`bookly-customers.json`（45人）は、8/30より前のエクスポート基準です。
> **公開直前（2026-08-30）に、Booklyの最新フルデータ（予約CSV＋顧客CSV）を改めて受領し、下記2ファイルを必ず再生成**します。
> 8/30までに入る新規予約・変更・キャンセルを取り込むためで、**件数（枠数・45人・143件・2軸6人）は最新データで変動します**（それが正）。
- [ ] 🧑‍💻 **8/30：Booklyの最新CSVを2種エクスポート**（①予約＝全期間 ②顧客名簿 Customers.csv）。
- [ ] 🤖 **予約を再生成**：`node scripts/bookly-parse.mjs <予約csvディレクトリ> src/data/bookly-slots.json` → 件数・スペース別をレビュー。
- [ ] 🤖 **顧客ロースターを再生成**：`node scripts/bookly-customers.mjs <Customers.csv> src/data/bookly-customers.json 2026-08-30` → 人数・`missingInCsv` が空（=メール100%一致）を確認。
- [ ] 🤖 2ファイルをコミット → **staging→production デプロイ**（両JSONがWorkerに同梱される）。
- [ ] **DBマイグレーションが本番適用済み**であること（`bookly_imports` 表 ほか）。未適用なら「DB migrate」ワークフロー staging→production（`staging_verified=yes`）。
- [ ] 🤖 **復旧リハーサル緑**：`npx vitest run test/bookly-recovery-drill.test.ts`（切断で全消し→復元が成立することの担保）。

### A-5. ステージングで予行演習（GO/NO-GO の予行）🧑‍💻
- [ ] ステージング管理画面 → システム状態 →「Bookly予約の移行」→ **名駅フリー（テストカレンダー）** で ①プレビュー→②取り込み。テストカレンダーに予定が入り、空き状況にも反映されることを確認。
- [ ] **OTA両方向テスト（重要・GO/NO-GO）**：本番カレンダーで
  1. 新システムからテスト予約1件 → スペースマーケット/インスタベースで同枠がブロックされるか。
  2. OTA側で1件入れ → 新システムのフォームが「空きなし」になるか。
  - 確認後テスト予約は削除。**両方向OKが公開の最終GO条件**。

---

## B. 公開当日（順番厳守・メンテ枠で実施）

> 詳細な分岐（切断がA=自分の分だけ消す/B=非OTA全消し のどちらか未確定でも安全な順序）は `launch-cutover-plan.md` 8章。以下はその実行版。

1. [ ] **【保険】バックアップ**：各スペースGoogleカレンダーを `.ics` エクスポート＋Bookly予約一覧CSVエクスポート。🧑‍💻
2. [ ] **本番カレンダー接続**：8スペースの `google_calendar_id` に**既存の本番カレンダー**を設定→接続テスト。**新規カレンダーは作らない**。🧑‍💻
3. [ ] **Bookly新規受付を停止**（申込フォーム撤去 or メンテ表示）。以降Booklyは書き込まない。🧑‍💻
4. [ ] **Bookly切断**を実行 → 直後に「OTA予定は残る／Bookly由来は消える」を確認。🧑‍💻
5. [ ] **Bookly予約の本番取り込み**：本番管理画面→「Bookly予約の移行」→全スペース→①プレビュー→②実行（`remaining=0` まで自動継続）。🧑‍💻
6. [ ] **チケット（回数券）の実投入（#82）**：GitHub → Actions →「**ticket-migration**」ワークフローで既存チケット残高を投入（`docs/ticket-migration.md` 参照）。🧑‍💻
7. [ ] **目視GO/NO-GO**：既知の予約数件（例：赤井様 9/10 13:00）がカレンダー・空き状況・管理画面に正しく出るか。サイネージ本文（タイトルの平日/土日祝・`[スペース名]`ブロック）も確認。🧑‍💻
8. [ ] **公式サイト側の申込導線を新システムへ切替**（予約ボタン→ booking.space-albe.com、お問い合わせフォームは既に `/api/contact` 連携済み）。🧑‍💻
9. [ ] **公開＝Basic認証ゲート解除**：本番Workerの `BASIC_AUTH_USER` と `BASIC_AUTH_PASS` を削除（Cloudflareダッシュボード → Worker → Settings → Variables and Secrets、または `wrangler secret delete BASIC_AUTH_USER` / `... BASIC_AUTH_PASS`）。両方消えるとゲートOFF＝一般公開。🧑‍💻
10. [ ] **Bookly はアンインストールせず「無効化のみ」で猶予保持**（旧予定がGoogleに残ることを確認、未来のBookly予約が消化されてから撤去検討）。🧑‍💻

---

## C. 公開直後の動作確認（スモークテスト）🧑‍💻

- [ ] 一般ブラウザ（ログインなし）でトップが**ゲートなしで開く**。
- [ ] **本番テスト予約を1件**（少額 or 直後に返金）→ カード決済が通る／Google予定が入る／空き反映。
- [ ] **メール着信**：予約受注（顧客・管理者）、（振込なら）口座案内、（チケット購入なら）購入完了。
- [ ] **Stripe Webhook 到達**（ダッシュボードのイベントログが 2xx）。
- [ ] **領収書/請求書PDF**がマイページから発行できる。
- [ ] **サイネージ**が新書式で表示される。
- [ ] **OTA**：公開後もスペースマーケット/インスタベースがブロック反映されている（Bookly切断の影響なし）。

---

## D. 中断・ロールバック基準

- **取り込みが途中失敗／件数不一致** → 「取り消し（ロールバック）」で戻し、原因（カレンダーID未設定・Google鍵）を直して再取り込み。
- **切断で新システム予定まで消えた（パターンB）** → **ロールバック→再取り込み**で完全復元（`launch-cutover-plan.md` 7-4・実証済み）。
- **OTA予定が空きに戻った** → OTAのチャネル同期で自己復旧を待つ（`.ics`手動復元はOTA分には使わない）。
- **公開直後に不整合** → サイトをメンテ表示に戻し、B-5〜B-7をやり直す（客の予約が入る前に是正）。

---

## E. 役割分担の目安

| 作業 | 主担当 |
|---|---|
| コード修正・CSV再生成・デプロイ・DB migrate・復旧リハーサル | 🤖 Claude（＋🧑‍💻がGitHub Actions実行） |
| GitHub Actions（Deploy / DB migrate / Production secrets / ticket-migration）の実行 | 🧑‍💻 運用者 |
| Cloudflare（Secrets・ゲート解除）、Stripe/PayPal本番設定、Googleカレンダー接続、OTA管理画面、Bookly操作、公式サイト側の導線切替 | 🧑‍💻 運用者 |

> Claudeは各ステップで手順提示・スクリプト・確認を支援します。GitHub/GCP/Stripe/OTA/Bookly/公式サイトの**管理画面操作は運用者側**で行ってください。
