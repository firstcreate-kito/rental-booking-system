# プロジェクト運用ルール（レンタルスペースALBE 予約システム）

このファイルは Claude Code が毎回自動で読み込みます。**運用の最重要ルールをここに集約**し、
セッションが変わっても抜け落ちないようにします。

---

## 🚦 デプロイは必ず「ステージング先行」（最重要・例外なし）

**どんなに小さな修正でも、必ず次の順序でデプロイする。本番へ直接デプロイしない。**

1. **ステージングへデプロイ** … GitHub → Actions → 「Deploy」→ `environment=staging`
2. **ステージングで動作確認** … `https://albe-booking-api-staging.rental-space-albe.workers.dev`
3. **本番へデプロイ** … GitHub → Actions → 「Deploy」→ `environment=production` かつ **`staging_verified=yes`**

- 理由：**ステージングと本番の差異を防ぐため**。差異が出ると本番だけで起きる不具合の温床になる。
- 技術的ガード：本番Deployは `staging_verified=yes` を選ばないと**ワークフローが失敗**する（`.github/workflows/deploy.yml`）。
- コード修正だけでなく、**見た目（CSS）の小さな調整も同じ手順**を守る。
- 例外：ユーザーが明示的に「本番へ直接」と指示した場合のみ本番先行を許容する。
  その場合も**必ずステージングにも同じコードを反映**し、環境差異を残さない。

> Claude への指示：ユーザーから修正・機能追加を受けたら、実装 → コミット/プッシュ →
> **まず staging をデプロイして確認を促し、承認を得てから production** を実行すること。
> いきなり production を実行しない。

---

## 環境の対応関係

| | 本番 | ステージング |
|---|---|---|
| Worker | `albe-booking-api` | `albe-booking-api-staging` |
| URL | https://booking.space-albe.com | https://albe-booking-api-staging.rental-space-albe.workers.dev |
| D1 | `albe_booking` | `albe_booking_staging` |
| コード | 同一（gitの同じ `src/` `public/`） | 同一 |

- `wrangler.jsonc` の `env.staging` は `"routes": []` を**必ず**明示（本番ドメイン奪取の再発防止）。
- staging の D1 ID はリポジトリ上はプレースホルダ。CI が `wrangler d1 list` から実IDを注入する。

## GitHub Actions ワークフロー

- **Deploy**：コードのデプロイ（staging / production）。上記ルールのガードあり。
- **Staging bootstrap**：ステージングの初期構築（D1作成→マイグレーション→シード→デプロイ）。
- **Staging secrets**：`*_STAGING` の鍵を staging Worker に投入（テストキーのみ・本番キーはガードで拒否）。
- **Production secrets**：`*_PROD` の鍵を本番 Worker に投入（`confirm=YES-PRODUCTION` 必須・テスト値はガードで拒否）。

## 品質ゲート（デプロイ前に自動実行）

- `npm run typecheck` と `npm test`（vitest）が Deploy ワークフローで自動実行され、失敗時はデプロイされない。
- DBスキーマ変更（`migrations/` に新ファイル）を伴う回は、コードデプロイとは別に
  `npm run db:migrate:staging` → 確認 → `npm run db:migrate:remote` を行う。

---

## 参照ドキュメント

- `docs/deploy-from-anywhere.md` … GitHubからのデプロイ手順
- `docs/staging-setup.md` … ステージングの構築・運用
- `docs/frontend-css-rules.md` … フロントのコーディングルール
- `docs/price-embed.md` … 公式サイト料金連動ウィジェット
- `docs/ticket-migration.md` … 既存チケット移行（#82・公開直前投入）
