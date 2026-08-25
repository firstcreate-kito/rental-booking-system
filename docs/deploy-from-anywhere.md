# 自宅・外出先からデプロイする（GitHub Actions）

開発PCやwranglerが無くても、**ブラウザ（スマホ可）からボタン1つでデプロイ**できる仕組みです。

## 仕組み（30秒）

```
あなた（ブラウザ）→ GitHubの「Run workflow」ボタン → GitHubのクラウドがデプロイを実行 → Cloudflareへ反映
```

- 実行はすべて**GitHubのサーバー上**で行われます。手元にNode/wranglerは不要。
- デプロイ前に自動でテスト（typecheck＋294件）が走り、**壊れたコードは反映されません**。

---

## 初回だけ：トークン登録（1回のみ・すべてブラウザで完結）

デプロイをGitHubに任せるため、Cloudflareの「デプロイ用の鍵（APIトークン）」を1回だけGitHubに預けます。

### ① Cloudflare APIトークンを作る

1. https://dash.cloudflare.com/profile/api-tokens を開く
2. **「Create Token」** → テンプレート **「Edit Cloudflare Workers」** の **Use template**
3. Account / Zone は既定のままで **Continue → Create Token**
4. 表示された**トークン文字列をコピー**（この画面を離れると二度と表示されません）

### ② Account ID を控える

1. https://dash.cloudflare.com/ で対象アカウントを開く
2. Workers & Pages のページ右側などにある **Account ID** をコピー
   （`wrangler whoami` でも確認できます）

### ③ GitHubに登録

1. リポジトリ → **Settings** → 左メニュー **Secrets and variables** → **Actions**
2. **New repository secret** を2つ作成：
   | Name | Secret（値） |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | ①でコピーしたトークン |
   | `CLOUDFLARE_ACCOUNT_ID` | ②でコピーしたAccount ID |

> 🔒 これらはGitHubに暗号化保存され、ログにも表示されません。Stripe等の**アプリのシークレットとは別物**（あれは今まで通りCloudflare側に保管されたまま）。このトークンは「デプロイする権限」だけです。

### ④ ワークフローを既定ブランチ（main）に載せる

「Run workflow」ボタンは、ワークフローファイルが**mainブランチにある**と表示されます。
→ 今回の変更を含むプルリクエストを**mainにマージ**すれば準備完了です（マージもブラウザ操作でOK）。

---

## ふだんの使い方（デプロイのたび）｜★ステージング先行が鉄則

**どんなに小さな修正でも、必ず「ステージング → 確認 → 本番」の順**で行います（環境差異の防止）。

### ① まずステージングへ
1. GitHubリポジトリ → 上部 **Actions** タブ
2. 左の一覧から **「Deploy」** を選択 → **「Run workflow」**
3. **environment** = `staging` を選ぶ（`staging_verified` は staging では無視されるのでそのままでOK）
4. 緑の **Run workflow** → 数分で完了

### ② ステージングで動作確認
- `https://albe-booking-api-staging.rental-space-albe.workers.dev` を開いて、修正箇所を実際に確認。

### ③ 問題なければ本番へ
1. 同じ **「Deploy」→「Run workflow」**
2. **environment** = `production`、かつ **`staging_verified` = `yes`** を選ぶ
3. **Run workflow**

> 🔒 **ガード**：本番は `staging_verified=yes` を選ばないと**ワークフローが失敗**します（ステージング確認を飛ばして本番へ出す事故の防止）。
> このルールは `CLAUDE.md` にも明記され、今後のAI作業でも「まずステージング→確認→本番」が徹底されます。

これで自宅でも外出先でも、スマホからでも安全にデプロイできます。

---

## よくある質問

**Q. これで手元の `npm run deploy` は使えなくなる？**
A. いいえ。従来どおりPCからのデプロイも併用できます。GitHub Actionsは「もう一つの入口」が増えるだけです。

**Q. DBのマイグレーションもできる？**
A. このワークフローは**コードのデプロイのみ**です。DB構造を変えた回（`migrations/` に新ファイルを足した回）は、別途 `npm run db:migrate:remote`（本番）/ `npm run db:migrate:staging` をPCから実行してください。頻度は低く、通常のデプロイはボタンだけで完結します。
（必要なら、マイグレーションもボタン化する別ワークフローを追加できます。）

**Q. 間違って本番を選んでしまわない？**
A. 既定は `staging` です。`production` は明示的に選んだときだけ。さらにデプロイ前にテストが通らないと実行されません。
