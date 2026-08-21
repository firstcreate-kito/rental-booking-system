# 既存チケットの移行（公開直前に実施）

- 作成: 2026-08-21
- 状態: **データ確定・実投入は公開直前に実施**（本ディレクトリのデータを使う）
- 出典: お客様提供の Excel「20260821_（チケット引継ぎ）」を検証・整形したもの

> ⚠️ **個人情報（PII）を含みます。** 本ディレクトリのCSVは実顧客の氏名・メール・電話です。
> リポジトリは非公開前提。外部共有・公開・エクスポート先には出さないこと。

---

## 1. 移行対象（確定）

- **残あり39件のみ**をチケットとして移行する（`tickets-migration.csv`）。
  - AB共通（名駅防音室A・B）：34件
  - 東別院：5件
  - 残時間合計：210時間
- **除外**：残なし26件・残数不明5件・購入後未払い1件 → 移行しない（顧客側が新規購入で対応）。

## 2. 変換ルール（確定）

| 項目 | ルール |
|---|---|
| 単位 | **1回 = 1時間**。旧「残りN回」→ `remaining_hours = N`、`total_hours = N`（移行時点の残＝総枠とする） |
| 有効期限 | **移行実行日から1年（365日）**。`valid_from = 実行日`, `valid_until = 実行日 + 365日` |
| 種別→対象スペース | `AB共通` → `meieki-piano-a` / `meieki-piano-b`（防音室A・B共通）<br>`東別院` → `higashibetsuin-piano-24h` |
| 旧チケットコード（erb3等） | **不問**（新システムはコード非依存）。移行しない |
| パスワード | 移行しない。空で顧客作成し、各人へ「アカウント引き継ぎ（パスワード設定）」メールを送る |
| 電話番号 | そのまま保持（海外番号可。システムの入力バリデーションは国際対応済み） |
| 氏名 | 前後空白・全角空白を整形済み。別名併記は原文のまま保持 |

## 3. CSVの列（`tickets-migration.csv`）

`name, email, phone, ticket_type, remaining_hours, validity_days`

- `ticket_type` … `AB共通` または `東別院`
- `remaining_hours` … 残時間（＝旧「残りN回」）
- `validity_days` … 365（実行日から起算）

## 4. 実投入の手順（公開直前）

1. 顧客の作成（email で名寄せ。既存顧客がいれば紐づけ、無ければ新規作成。`password_hash` は空、`is_registered=1`）。
2. チケットの作成：`tickets` に1件ずつ INSERT。
   - `customer_id`（上記）、`product_id = NULL`（移行のため既製SKUに紐づけない）、
   - `name = '移行チケット（AB共通）'` などの表示名、
   - `total_hours = remaining_hours`、`remaining_hours = remaining_hours`、
   - `valid_from = 実行日`、`valid_until = 実行日+365日`、`status = 'active'`、`purchased_at = 実行日`。
   - 対象スペースを `ticket_spaces` に登録（AB共通=piano-a/piano-b、東別院=higashibetsuin）。
3. 各顧客へ「アカウント引き継ぎ（パスワード設定リンク）」メールを送付。
4. 投入後、`tickets` 件数（39）と残時間合計（210）を照合。

> 実装（移行スクリプト）は公開直前にこのREADMEの仕様どおり作成・実行する。
> それまではデータと仕様の保管のみ（本タスク）。
