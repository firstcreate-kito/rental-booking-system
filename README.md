# レンタルスペースALBE 予約システム

レンタルスペースALBEの予約業務を効率化する自社開発の予約管理システム。
現行の WordPress + Bookly から、Cloudflare Workers + D1 を中心としたヘッドレス構成へ移行する。

## ドキュメント

| ファイル | 内容 |
|----------|------|
| [`docs/spec-v2.0.md`](docs/spec-v2.0.md) | 開発仕様書 v2.0（正本） |
| [`docs/spec-addendum-v2.1.md`](docs/spec-addendum-v2.1.md) | v2.1 追補（実装前ヒアリングで確定した変更点・追加機能・技術方針） |

> 仕様に相違がある場合は **追補（v2.1）を優先** します。

## 技術スタック（予定）

| レイヤー | 技術 |
|----------|------|
| バックエンドAPI | TypeScript + Hono（Cloudflare Workers） |
| データベース | Cloudflare D1（SQLite互換） |
| フロントエンド（顧客） | HTML + JavaScript |
| フロントエンド（管理） | TypeScript + React（Cloudflare Pages） |
| サイネージ | HTML + JavaScript |
| カレンダー同期 | Google Calendar API |
| メール通知 | Resend（予定） |
| 決済 | Stripe（Phase 4） |

## 開発フェーズ

| フェーズ | 内容 | 状況 |
|----------|------|------|
| Phase 1 | 予約API基盤（D1 + 料金計算 + Google Calendar同期） | 準備中 |
| Phase 2 | フロントエンドUI（カレンダー + カート + 予約フロー） | 未着手 |
| Phase 3 | 管理画面 + 自動化連携 | 未着手 |
| Phase 4 | 決済統合（Stripe） | 未着手 |
