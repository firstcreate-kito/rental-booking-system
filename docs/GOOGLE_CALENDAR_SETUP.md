# Googleカレンダー連携の設定手順

予約システムとGoogleカレンダーを連携させるための準備手順です。
**サービスアカウント**（システム専用のGoogleアカウントのようなもの）を作り、
各部屋のカレンダーをそれに共有します。

> まずは「予約テスト」カレンダー1つで動作確認 → 問題なければ本番カレンダーに広げます。

---

## パート1：サービスアカウントを作る（Google Cloud）

### 1. Google Cloud Console を開く
https://console.cloud.google.com/ にGoogleアカウントでログイン。

### 2. プロジェクトを作成
- 画面上部のプロジェクト選択 →「新しいプロジェクト」
- 名前：`albe-booking` などで作成 → 作成後、そのプロジェクトを選択

### 3. Googleカレンダー APIを有効化
- 左メニュー「APIとサービス」→「ライブラリ」
- 「Google Calendar API」を検索 →「有効にする」

### 4. サービスアカウントを作成
- 左メニュー「APIとサービス」→「認証情報」→「＋認証情報を作成」→「サービスアカウント」
- 名前：`albe-calendar` など →「作成して続行」
- ロール（権限）は**設定不要**（カレンダー権限は後の“共有”で付与）→「完了」

### 5. キー（JSON）を作成・ダウンロード
- 作成したサービスアカウントをクリック →「キー」タブ →「鍵を追加」→「新しい鍵を作成」→「JSON」→「作成」
- **JSONファイルが自動ダウンロード**されます。これは大事な認証情報なので厳重に保管（このファイルの中身は誰にも共有しない）

このJSONの中に、後で使う2つの値が入っています：
- `client_email`（例：`albe-calendar@albe-booking.iam.gserviceaccount.com`）
- `private_key`（`-----BEGIN PRIVATE KEY-----\n...` で始まる長い文字列）

---

## パート2：カレンダーをサービスアカウントに共有

### 6. サービスアカウントのメールをコピー
JSONの `client_email` の値（`...iam.gserviceaccount.com`）をコピー。

### 7. 「予約テスト」カレンダーを共有
- Googleカレンダーを開く → 左「マイカレンダー」で対象カレンダーの「⋮」→「設定と共有」
- 「特定のユーザーやグループと共有」→「ユーザーを追加」→ 6のメールを貼り付け
- 権限を **「予定の変更権限」** にする → 送信/保存

---

## パート3：カレンダーIDを取得

### 8. カレンダーIDをコピー
- 同じ「設定と共有」画面の下の方「カレンダーの統合」→「カレンダー ID」
- 例：`xxxxxxxxxx@group.calendar.google.com` をコピー

---

## パート4：予約システムに登録

### 9. 認証情報を登録（PCで。値の入力を求められたら入力）
```powershell
npx wrangler secret put GOOGLE_SA_EMAIL
```
→ JSONの `client_email`（`...iam.gserviceaccount.com`）を貼り付け

```powershell
npx wrangler secret put GOOGLE_SA_PRIVATE_KEY
```
→ JSONの `private_key` の**値をそのまま**貼り付け（`-----BEGIN PRIVATE KEY-----\n...-----END PRIVATE KEY-----\n` の1行。前後のダブルクォートは含めない）

### 10. カレンダーIDをスペースに設定
- 管理画面 →「スペース設定」→ 対象スペースを編集 →「GoogleカレンダーID」欄に8のIDを貼り付け → 保存

### 11. 反映
```powershell
npm run deploy
```

---

## 動作確認
- テスト用スペースで予約を1件入れる → Googleカレンダー（予約テスト）に予定が入ればOK
- Googleカレンダー側に手動で予定を入れる → 予約システムの空き状況にも反映されればOK（＝相互連携）

`GOOGLE_SA_EMAIL` と `GOOGLE_SA_PRIVATE_KEY` の両方が設定され、スペースにカレンダーIDが
入っているときのみ連携が有効になります。未設定なら従来通り（連携なし）動作します。
