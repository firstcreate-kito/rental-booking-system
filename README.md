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
| Phase 1 | 予約API基盤（D1 + 料金計算 + Google Calendar同期） | 進行中 |
| Phase 2 | フロントエンドUI（カレンダー + カート + 予約フロー） | 未着手 |
| Phase 3 | 管理画面 + 自動化連携 | 未着手 |
| Phase 4 | 決済統合（Stripe） | 未着手 |

## 開発の始め方（ローカル）

```bash
npm install
npm run db:reset:local   # ローカルD1を初期化 + シード投入
npm run dev              # http://localhost:8787 で起動
npm test                # ユニットテスト(vitest)
npm run typecheck       # 型チェック
```

> Cloudflareアカウント未契約のため、当面はローカル（Wrangler + ローカルD1）で開発します。

## 実装済みAPI（Phase 1）

| メソッド | パス | 説明 |
|----------|------|------|
| GET | /api/spaces | スペース一覧 |
| GET | /api/spaces/:id | スペース詳細 |
| GET | /api/spaces/:id/slots?month=YYYY-MM | 月間の稼働状況（○△✕・商談中・季節料金） |
| POST | /api/bookings | 予約作成（ゲスト・料金計算・競合防止・採番） |
| GET | /api/bookings/:number | 予約取得（予約番号指定） |

### 料金計算エンジン
- `src/lib/pricing.ts` … スペース料金（時間/1日/最低利用/曜日・祝日/季節/残置）
- `src/lib/discounts.ts` … クーポン/チケット/ポイント/キャンペーン/オプション（併用ルール）
- `src/lib/availability.ts` … 稼働状況○△✕・予約バリデーション

テスト: `test/` に46ケース（実料金表に基づく検証）。
