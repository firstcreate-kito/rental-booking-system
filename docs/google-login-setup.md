# Googleログインの有効化手順（オーナー作業）

システム側（マイページの「Googleでlog-in」ボタンと認証処理）は実装済みです。
あとは **Google Cloud で「ログイン用アプリ」を登録して鍵を設定するだけ**で有効になります。
鍵を設定するまではボタンは自動的に非表示のままなので、既存のログインには影響しません。

---

## A. Google Cloud で OAuth クライアントを作成

1. [Google Cloud Console](https://console.cloud.google.com/) にログイン（会社のGoogleアカウント推奨）。
2. 上部でプロジェクトを選択（無ければ「新しいプロジェクト」を作成。名前は「ALBE予約」など）。
3. 左メニュー **「APIとサービス」→「OAuth 同意画面」**：
   - User Type：**外部**を選択 →「作成」
   - アプリ名：**レンタルスペースALBE**／ユーザーサポートメール：貴社メール
   - 「アプリのドメイン」→ 承認済みドメインに **`space-albe.com`** を追加
   - デベロッパー連絡先：貴社メール →「保存して次へ」
   - スコープ：そのまま「保存して次へ」（`email`/`profile`/`openid` は既定で付きます）
   - テストユーザー：公開前に自分のGmailを追加しておくとテストできます →「保存して次へ」
   - 公開ステータス：動作確認後に **「アプリを公開」**（本番利用に必要）
4. 左メニュー **「認証情報」→「＋認証情報を作成」→「OAuth クライアント ID」**：
   - アプリケーションの種類：**ウェブ アプリケーション**
   - 名前：`ALBE予約 Web`
   - **承認済みのリダイレクト URI** に次を**そのまま**追加（重要・完全一致）：
     ```
     https://booking.space-albe.com/api/auth/google/callback
     ```
   - 「作成」を押すと **クライアントID** と **クライアントシークレット** が表示されます。両方コピー。

---

## B. システムに鍵を設定（PowerShell）

プロジェクトフォルダで、1行ずつ実行します。実行すると値の入力を求められるので、
コピーした値を貼り付けて Enter（画面には表示されません）。

```
npx wrangler secret put GOOGLE_CLIENT_ID
```
→ クライアントID（`xxxxx.apps.googleusercontent.com`）を貼り付け → Enter

```
npx wrangler secret put GOOGLE_CLIENT_SECRET
```
→ クライアントシークレットを貼り付け → Enter

その後、反映のためデプロイ：
```
npm run deploy
```

---

## C. 動作確認

1. `https://booking.space-albe.com/mypage.html` を開く。
2. ログイン画面に **「Googleでログイン」ボタン**が表示される（鍵設定後に自動表示）。
3. 押す → Googleの選択画面 → 戻ってきて**ログイン完了**。
   - 初めてのメールなら、その場で会員登録も兼ねます。

うまくいかない場合、画面に日本語のエラーが出ます（例：「セキュリティ確認に失敗しました」）。
その文言と、Google Cloud のリダイレクトURI設定のスクショをいただければ調整します。
一番多いのは **リダイレクトURIの不一致**（末尾スラッシュやスペル、httpsの有無）です。上記Bと完全一致か確認してください。

---

## メモ（技術）

- 認証方式：OAuth 2.0 / OpenID Connect（Authorization Code）。`openid email profile` を取得。
- コールバック：`/api/auth/google/callback` でトークン交換 → メール確認 → 既存のマジックリンク方式で
  マイページにログイン（1回限りトークン）。CSRF対策に `state` を使用。
- 鍵は `wrangler secret`（暗号化保存）で管理。コードやGitには含めません。
- 費用：**無料**（Googleログインの利用料はかかりません）。
- 同じ手順の考え方で、後日 LINE・Yahoo! JAPAN ID も追加できます（別途各社で登録）。
