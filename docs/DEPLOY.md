# 本番公開（Cloudflare へのデプロイ）手順

レンタルスペースALBE 予約システムを Cloudflare Workers + D1 に公開する手順です。
**お手元の Windows PC のターミナル（PowerShell）** で、プロジェクトのフォルダに入って実行します。

> クラウド開発環境から Cloudflare へは直接デプロイできない（ネットワーク制限）ため、
> この作業だけはご自身の PC で行っていただく必要があります。

## 前提
- Node.js が入っていること（`node -v` でバージョンが出ればOK）
- 最新のコードを取得済みであること（`git pull`）
- プロジェクトフォルダで `npm install` 済みであること

---

## 手順（コピペで実行）

### 1. Cloudflare にログイン
```powershell
npx wrangler login
```
→ ブラウザが開くので「Allow / 許可」を押します。ターミナルに「Successfully logged in」と出ればOK。

### 2. 本番用データベース（D1）を作成
```powershell
npx wrangler d1 create albe_booking
```
→ 出力の中に次のような行があります。**database_id の値（英数字とハイフンのID）をコピー**してください。
```
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 3. 設定ファイルにデータベースIDを反映
```powershell
node scripts/set-d1-id.mjs <コピーしたID>
```
例: `node scripts/set-d1-id.mjs 1a2b3c4d-...`
→ 「✓ wrangler.jsonc の database_id を … に設定しました」と出ればOK。

### 4. データベースの構造（テーブル）を作成
```powershell
npm run db:migrate:remote
```
→ 確認を聞かれたら `y` を入力。全テーブルが作成されます。

### 5. 初期データ（スペース・オプション・設定）を投入
```powershell
npm run db:seed:remote
```
→ 9スペース・オプション・料金設定などが入ります。
（※デモ用の会員／管理者アカウントは本番には入りません）

### 6. 公開（デプロイ）
```powershell
npm run deploy
```
→ 完了すると公開URLが表示されます。例:
```
https://albe-booking-api.<あなたのサブドメイン>.workers.dev
```

---

## デプロイ後にやること

1. **管理者アカウントの作成**
   公開URLの末尾に `/admin.html` を付けて開きます。
   例: `https://albe-booking-api.xxxx.workers.dev/admin.html`
   → 「初回セットアップ」画面が出るので、お名前・メール・パスワード（8文字以上）を入力して
   最初のオーナーアカウントを作成します。

2. **動作確認**
   - お客様画面: `https://（公開URL）/`
   - 部屋ごとのURL: `https://（公開URL）/?space=albe-hall-nagoya` など
   - 管理画面: `https://（公開URL）/admin.html`

3. **設定ファイルの保存（任意・推奨）**
   手順3で書き換えた `wrangler.jsonc` をコミットしておくと、次回以降のデプロイが楽になります。

---

## 2回目以降の更新デプロイ

コードを更新したあとは、これだけでOKです（DB作成や初期データ投入は不要）:
```powershell
npm run deploy
```

データベースの構造を変更した（新しいマイグレーションを追加した）ときのみ:
```powershell
npm run db:migrate:remote
npm run deploy
```

---

## 開発中の公開ゲート（ベーシック認証）

開発中は、URLを知っている人でも閲覧できないよう、サイト全体（お客様画面・
管理画面・API）にID/パスワードのゲートをかけられます。

**有効にする**（本番Workerに認証情報を登録。1行ずつ実行し、値の入力を求められたら入力）:
```powershell
npx wrangler secret put BASIC_AUTH_USER
npx wrangler secret put BASIC_AUTH_PASS
```
→ それぞれ ID とパスワードを入力（**半角英数字**で設定してください）。登録後、
反映するために再デプロイ:
```powershell
npm run deploy
```
以降サイトを開くと、ブラウザにID/パスワードの入力を求められます。

**一般公開する（ゲートを外す）**ときは、登録した認証情報を削除して再デプロイ:
```powershell
npx wrangler secret delete BASIC_AUTH_USER
npx wrangler secret delete BASIC_AUTH_PASS
npm run deploy
```
（`BASIC_AUTH_USER` と `BASIC_AUTH_PASS` の両方が設定されているときだけゲートが
有効になります。片方でも未設定なら誰でも閲覧できます）

## 困ったとき
- `wrangler login` でブラウザが開かない → 表示されたURLを手動でブラウザに貼り付け。
- `npm run deploy` でエラー → メッセージをそのまま共有してください。
- 独自ドメイン（例: booking.albe.jp）を使いたい → Cloudflare ダッシュボードの
  Workers & Pages → 対象Worker → Settings → Domains & Routes から設定できます（後日対応可）。
