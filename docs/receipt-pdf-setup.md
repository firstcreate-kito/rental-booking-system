# 領収書・請求書のサーバー側PDF生成（Browser Rendering）

スマホのアプリ内ブラウザ（メール／LINE 等）では `window.print()` が効かず、PDFに
保存できないことがある。これを解消するため、`?format=pdf` でアクセスすると
**サーバー側で本物のPDFを生成してダウンロード**させる仕組みを用意している
（Cloudflare Browser Rendering の REST API を利用）。

## 挙動

- `CF_ACCOUNT_ID` と `CF_BROWSER_API_TOKEN` の**両方が設定されているときだけ**有効。
  - 領収書/請求書の画面上部に「⬇ PDFをダウンロード」ボタンが出る。
  - `?format=pdf` が本物のPDF（A4）を返す。
- **未設定・生成失敗時は自動でHTML表示にフォールバック**するので、既存の
  「画面で開いて印刷→PDF保存」は今までどおり使える（デプロイが壊れることはない）。

## セットアップ手順（一度だけ）

1. **Browser Rendering を有効化**
   - Cloudflare ダッシュボード → 対象アカウントで Browser Rendering を有効化
     （Workers 有料プランが必要。従量課金・無料枠あり）。

2. **アカウントIDを確認**
   - ダッシュボード右側、または `npx wrangler whoami` で確認できる32桁の英数字。

3. **APIトークンを作成**
   - My Profile → API Tokens → Create Token → Custom token
   - Permissions に **Browser Rendering : Edit**（＝実行権限）を付与して作成。

4. **シークレットを登録**（PowerShell・プロジェクトフォルダで）
   ```powershell
   npx wrangler secret put CF_ACCOUNT_ID
   # → プロンプトにアカウントIDを貼り付けてEnter

   npx wrangler secret put CF_BROWSER_API_TOKEN
   # → プロンプトに作成したAPIトークンを貼り付けてEnter
   ```

5. **デプロイ**
   ```powershell
   npm run deploy
   ```

これで領収書ページに「PDFをダウンロード」ボタンが表示され、スマホでも確実に
PDFを保存できるようになる。

## 仕組みメモ

- `src/routes/documents.ts` が `?format=pdf` を受け、`?format=html` の実ページURLを
  Browser Rendering に渡してレンダリングさせる（社印・フォント等のアセットも
  そのまま反映される）。
- 生成物は `Content-Disposition: attachment` で返すため、ブラウザ／webビューが
  ダウンロード（または共有→保存）として扱える。
