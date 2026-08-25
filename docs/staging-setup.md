# ステージング（テスト環境）構築・運用ガイド #84

- 対象: レンタルスペースALBE 予約システム
- 目的: **本番に反映する前に、本番と同じ構成で安全にテストできる環境**を用意する。
- 作成日: 2026-08-24 ／ 関連バックログ #84

---

## ★ 立ち上げ方法（推奨：GitHubから・PC不要）

GitHub → **Actions** → **「Staging bootstrap」** → **Run workflow** を押すだけで、
D1作成 → wrangler.jsoncへID注入 → マイグレーション → 初回シード → デプロイ まで自動実行されます。
- 何度実行しても安全（D1は再利用、シードは spaces が空の初回のみ投入。`reseed=yes` で強制再投入）。
- 前提：GitHub Secrets に `CLOUDFLARE_API_TOKEN`（**Account→D1→Edit 権限が必要**）が登録済み。
- デプロイ後のURL（ログに表示）:
  `https://albe-booking-api-staging.rental-space-albe.workers.dev`

> ⚠️ **重要（再発防止）**：`routes` は named environment に継承されるため、`wrangler.jsonc` の
> `env.staging` には **`"routes": []` を必ず明示**しています。これが無いと本番ドメイン
> `booking.space-albe.com` をステージングが奪ってしまいます（過去に一度発生・修正済み）。

以下（PowerShellでの手動手順）は、ローカルから操作したい場合の代替手段です。

---

## 0. これは何？（30秒で理解）

**「本番と同じ設備のミニチュア店舗」を1つ持つ、というだけの話です。**

- コードは**1つ**（gitの同じ `src/`）。作り直しは発生しません。
- 新機能は **まずステージングへデプロイ → テスト → OKなら本番へデプロイ** の2段階にするだけ。

```
              ┌─ npm run deploy:staging → テストURL（workers.dev）で確認
1つのコード ─┤
              └─ npm run deploy         → 本番（booking.space-albe.com）へ反映
```

| | ステージング | 本番 |
|---|---|---|
| Worker名 | albe-booking-api-**staging** | albe-booking-api |
| D1（データ） | テスト用（別物・空） | 本番の予約・売上 |
| URL | `…-staging.<サブドメイン>.workers.dev` | booking.space-albe.com |
| Stripe | **テスト**キー（sk_test…） | 本番キー（sk_live…） |
| 自動Cron | **止めてある**（メール暴発しない） | 稼働 |
| お客様への影響 | **一切なし** | 実運用 |

> ステージングでどれだけテスト予約を入れても、本番の予約・カレンダー・お客様メール・売上には**一切影響しません**。

---

## 1. 初回セットアップ（1回だけ・PowerShellで実行）

作業ディレクトリ: `C:\Users\kyton\rental-booking-system`

> ⚠️ すべて `npx wrangler …` で実行します。事前に `npx wrangler login` 済みであること。

### ステップ1: ステージング用D1データベースを作成

```powershell
npx wrangler d1 create albe_booking_staging
```

実行すると、出力の中に次のような行が出ます（例）:

```
database_id = "abcd1234-5678-90ab-cdef-1234567890ab"
```

この **UUID をコピー**してください。

### ステップ2: 作成したD1のIDを設定ファイルに反映

コピーしたIDを使って（`--staging` を必ず付ける）:

```powershell
node scripts/set-d1-id.mjs abcd1234-5678-90ab-cdef-1234567890ab --staging
```

`✓ wrangler.jsonc の database_id（albe_booking_staging / ステージング）を … に設定しました。` と出ればOK。
（本番用IDは書き換わりません。database_name で見分けています。）

### ステップ3: ステージングD1にテーブルを作成＋初期データ投入

```powershell
npm run staging:setup
```

これは内部で次を順に実行します:
1. `db:migrate:staging` … テーブル作成（本番と同じマイグレーション）
2. `db:seed:staging` … スペース・オプション・チケット・事業者情報の初期データ投入
3. `deploy:staging` … ステージングWorkerを初回デプロイ

デプロイ完了時に、次のようなURLが表示されます:

```
https://albe-booking-api-staging.<あなたのサブドメイン>.workers.dev
```

この **URLがステージングのアドレス**です。ブックマークしておいてください。

> 📌 表示されたサブドメインが `rental-space-albe` と違う場合は、`wrangler.jsonc` の
> ステージング `PUBLIC_BASE_URL` を実URLに合わせて、もう一度 `npm run deploy:staging`。
> （書類・メール内リンクの基底URLに使うため。テスト用途なら未一致でも動作はします。）

### ステップ4: ステージング用のシークレット（鍵）を投入

シークレットは Worker ごとに別管理です。**`--env staging` を必ず付けます。**
本番の鍵は入れず、**テスト用**の値を入れます（Stripeテストキー等）。

必須（メール送信・基本動作）:
```powershell
npx wrangler secret put RESEND_API_KEY --env staging
npx wrangler secret put MAIL_FROM --env staging
npx wrangler secret put MAIL_ADMIN --env staging
```
- `MAIL_ADMIN` は**ご自身のメールアドレス**にしておくと、テストの管理者通知が自分に届いて確認しやすいです。

任意（テスト内容に応じて）:
```powershell
# 決済（Stripeテストモードのキー sk_test… / whsec…（テスト用Webhook））
npx wrangler secret put STRIPE_SECRET_KEY --env staging
npx wrangler secret put STRIPE_WEBHOOK_SECRET --env staging

# PayPal（sandbox）
npx wrangler secret put PAYPAL_CLIENT_ID --env staging
npx wrangler secret put PAYPAL_CLIENT_SECRET --env staging
npx wrangler secret put PAYPAL_MODE --env staging   # 値: sandbox

# Googleカレンダー連携をテストするなら（テスト用カレンダーのサービスアカウント推奨）
npx wrangler secret put GOOGLE_SA_EMAIL --env staging
npx wrangler secret put GOOGLE_SA_PRIVATE_KEY --env staging

# 公開ゲート（テスト環境も見せたくないので付けておくのが安全）
npx wrangler secret put BASIC_AUTH_USER --env staging
npx wrangler secret put BASIC_AUTH_PASS --env staging
```

投入済みの一覧を確認:
```powershell
npx wrangler secret list --env staging
```

投入後に反映するため、もう一度デプロイ:
```powershell
npm run deploy:staging
```

これで初回セットアップ完了です。🎉

### ステップ5: モードを画面で最終確認

ステージングURLを開いて管理画面にログイン →「**システム状態**」タブを開きます。
- 上部バナーが **🧪 テスト環境（ステージング）** になっていること
- **Stripe = テスト(test)** / **PayPal = サンドボックス** になっていること
を確認してください（本番と取り違えていないかの最終チェック）。
※ この画面は**秘密の鍵そのものは一切表示しません**（設定済みか・モードだけ）。

---

## 2. ふだんの使い方（新機能をテストしてから本番へ）

コードを変更したら、次の順で進めます。

```powershell
# 1) まずステージングへ
npm run deploy:staging

# 2) テストURL（…-staging.….workers.dev）を開いて、実際に動かして確認
#    予約→決済→変更→キャンセル→メール など、影響が心配な操作を試す

# 3) DBの構造を変えた（migrations/ に新ファイルを足した）ときだけ、先にマイグレーション
npm run db:migrate:staging
#    ↑ その後もう一度 npm run deploy:staging

# 4) ステージングで問題なければ、本番へ
npm run db:migrate:remote   # ← DBの構造を変えた場合のみ
npm run deploy              # ← 本番反映
```

> 💡 **鉄則**: 「DBの構造を変えるマイグレーション」は、必ず**ステージングで先に**流して壊れないか確認してから本番へ。

### ログを見る（不具合調査）
```powershell
npm run tail:staging     # ステージングのリアルタイムログ
npx wrangler tail albe-booking-api   # 本番のリアルタイムログ
```

---

## 3. よくある質問

**Q. ステージングと本番、コードは別々に管理するの？**
A. いいえ。コードは1つ（同じgitリポジトリの `src/`）。デプロイ先（Worker/D1/ドメイン）だけが違います。

**Q. ステージングでテストデータが散らかった。消したい。**
A. ステージングD1を初期化してOK（本番に影響なし）。
```powershell
npx wrangler d1 execute albe_booking_staging --remote --env staging --command "DELETE FROM bookings; DELETE FROM booking_items;"
```
テーブルごと作り直したいときは、Cloudflareダッシュボードで `albe_booking_staging` を削除→ステップ1から再作成。

**Q. 自動Cron（未入金アラート等）はステージングで動く？**
A. 意図的に**止めてあります**（`wrangler.jsonc` の staging → `triggers.crons: []`）。本番の受信箱にテスト通知が飛ばないようにするためです。Cron自体をテストしたいときは、一時的に本番と同じ配列に変えてデプロイして検証してください。

**Q. お客様に間違ってメールが飛ばない？**
A. ステージングは**テストデータしか入れない**運用なので、宛先はご自身/テスト用アドレスだけになります。`MAIL_ADMIN` を自分宛にしておくと安心です。

**Q. 費用は？**
A. Cloudflare Workers/D1 の無料枠内で収まる規模です（テスト用途の少量アクセス）。

---

## 4. 構成の技術メモ（引き継ぎ用）

- 仕組み: Wrangler の **named environment**（`env.staging`）。本番設定を土台に、名前・D1・vars・triggers・ドメインだけ差し替える。
- 変更ファイル:
  - `wrangler.jsonc` … `env.staging` ブロックを追加（別Worker名／workers.dev配信／別D1／`APP_ENV=staging`／Cron停止）。
  - `package.json` … `deploy:staging` `db:migrate:staging` `db:seed:staging` `staging:setup` `tail:staging` を追加。
  - `scripts/set-d1-id.mjs` … `--staging` で staging 側の database_id だけを安全に書き換えられるよう拡張。
- 本番ドメイン（`routes` の custom_domain）は named environment には**継承されない**ため、ステージングが booking.space-albe.com を奪うことはない。
- シークレットは Worker 単位で分離。`--env staging` を付けた `wrangler secret put` はステージングWorkerにだけ入る。
