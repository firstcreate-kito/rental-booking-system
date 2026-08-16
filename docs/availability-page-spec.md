# 空き状況ページ（/availability/）技術仕様メモ

> 電話・LINEの「◯月◯日、◯◯空いてますか？」を、お客様が同じ言葉の順序で自己解決 →
> そのまま予約できるページ。**日付起点**で、その日に使える施設を一覧表示する。
> 現行URL `https://space-albe.com/availability/` を維持（SEO資産の継承）。

作成日：2026-08-16 ／ 対象：レンタルスペースALBE ／ ステータス：実装前レビュー用

---

## 0. 確定した方針

- **判定は緩い版**：営業時間内に**1時間でも空きがあれば「空きあり(○)」**。最小利用時間で絞らない。空き時間帯（free_windows）をそのまま見せ、利用可否の最終判断はお客様に委ねる。
- **商談中(△)は満室と別扱い**：「ご相談は承ります」と明記し、問い合わせへ誘導。
- **カタログは自動増加**：システムに登録された公開中の全施設をループ表示。提携店などを追加すれば自動で並ぶ（特別枠なし）。
- **SSR（サーバー生成）**：Worker が D1 を引いて HTML を組み立てて返す。初期表示は完全SSR＝検索エンジン・AIに読まれる。
- **ホスティング**：ConoHa WING（サイト本体）はそのまま。前段に Cloudflare を置き、`space-albe.com/availability/*` だけ Worker ルートに向ける。URL完全維持。
- **鮮度**：D1（5分ごとにGoogleカレンダー同期）のみ参照。Googleは直接叩かない。「最終更新 ◯時◯分」を小さく表示（“リアルタイム”とは書かない）。

---

## 1. 追加スキーマ（spaces への列追加・1マイグレーション）

| 列 | 型 | 用途 | 初期値 |
|---|---|---|---|
| `area` | TEXT | エリア絞り込み（meieki/sakae/naka/chikusa/other 等） | 既存施設に投入 |
| `use_category` | TEXT | 用途絞り込み（piano/photo/event/storage・複数はカンマ区切り） | 既存施設に投入 |
| `room_group` | TEXT | 同型グループID（防音室A/Bを1件に集約し「空き◯室／2室」表示） | NULL（未グループ） |
| `same_day_cutoff_hours` | INTEGER | 当日、利用開始の何時間前まで受付か | 1 |
| `same_day_priority` | INTEGER | 「今日」タブの並び順（当日予約の多い順） | sort_order 準拠 |

- **既に持っているデータ**：`booking_deadline_days`（0=当日OK / N=N日前まで）、`open_time`/`close_time`、`billing_type`、`slot_minutes`、`is_active`、`slug`、料金各種。
- `availability_mode` は**不要**（緩い判定のため）。
- **同期最終時刻**：`system_settings` に `gcal_last_sync_at` を追加し、5分同期の成功時に更新（「最終更新」表示用）。

## 2. 空き状況の判定ルール（1日・1施設）

占有とみなすステータス：`confirmed / tentative / blocked / held`（既存 `computeDayAvailability` を流用）。

```
営業時間を slot_minutes 刻みに割る → 占有スロットを塗る → 空きスロットを数える
  空き=0                → ✕ 満室
  空き>0 かつ 商談中あり  → △ 商談中（相談を受け付ける）※満室と別扱い
  空き>0                → ○ 空きあり
  休業/予約不可日        → − 表示（または非表示）
free_windows = 空きが連続する時間帯の配列（例 ["13:00〜17:00","19:00〜22:00"]）
```

- **多室（room_group）**：同一グループの各室を上記判定し、`rooms_free / rooms_total` を集計。1室でも○なら行としては「空きあり」。
- **1日料金施設**：緩い判定のまま（特別扱い不要）。空き時間帯がそのまま出るので相談で拾える。

## 3. 当日予約の扱い（「今日」を選んだとき）

- **受付可否** = `booking_deadline_days == 0` かつ **現在時刻が「開始時刻 − same_day_cutoff_hours」を過ぎていない**枠がある。
- 受け付けていない／締切超過の施設は**一覧から消さず**、別グループ **「当日予約を承っていません（最短で ◯月◯日から）」** に出す。
- 「今日」タブの並び順は `same_day_priority` 昇順（例：防音室A/B → 東別院 → エクササイズ → フリースペース）。

## 4. 「次に空いているのは ◯月◯日」

- ②商談中・③当日不可・④満室の行に**必ず**表示（機会損失防止）。
- 実装：対象日から前方へ最大 N 日（例30〜45日、`booking_horizon_days` 上限）走査し、最初に○になる日を返す。
- 性能：**全施設×N日ぶんの占有を1クエリでまとめ取り**し、メモリ上で判定（施設ごと・日ごとにクエリを撃たない）。

## 5. API（内部・SSRからも利用）

```
GET /api/availability?date=YYYY-MM-DD[&use=piano&area=meieki]
→ {
  date, weekday, lastSyncAt,
  summary: { openCount, total },
  spaces: [{
    id, name, area, areaName, useCategory, meta, price, unit,
    roomGroup, roomsTotal, roomsFree,
    status: "ok"|"talk"|"no"|"closed",
    freeWindows: ["13:00〜22:00", ...],
    sameDayOk: bool,          // 「今日」判定時のみ意味を持つ
    nextOpen: "2026-09-03"|null,
    bookingHref: "/?space=<slug>&date=..."   // ○行→予約フローへ
  }, ...]
}
```
- 全施設一括・D1のみ参照。`Cache-Control: public, max-age=300`（＝同期間隔と同じ5分）。

## 6. SSR ページ `/availability/`

- Worker が同ロジックで**HTMLを生成して返す**（Hono `c.html`）。初期表示（既定=今日）は完全SSR。
- **日付切替**（今日/明日/今週末/日付指定）：URL に `?date=` を反映し、各日付も**単独URLでSSR可能**（クロール・共有に強い）。チップ操作は `/api/availability` を取得して再描画（プログレッシブ・エンハンスメント）。
- **必須要件の充足**：
  - `:root` デザイントークン＋**共通ヘッダー／フッター／パンくず**を部品化。
  - フッターに**法務リンク**（ご利用規約・特定商取引法・プライバシーポリシー・運営会社）。
  - `title` / `description`（指定文言）、`canonical=https://space-albe.com/availability/`。
  - **モバイルファースト**（検索流入78%がモバイル）。
  - 「最終更新 ◯時◯分」を小さく表示。
- **導線**：○行→予約フロー（`?space=&date=`）。下部に「条件が見つからないとき」＝問い合わせフォーム＋LINE。

## 7. sitemap・内部リンク

- `GET /sitemap.xml` を追加（`/availability/` を含む）。
- サイト側トップ/各施設ページから `/availability/` へ内部リンク（サイト側の作業）。

## 8. 公開・認証（BASIC ゲート）

- 本番：`BASIC_AUTH_USER/PASS` 未設定＝ゲート無効（全公開）。
- ステージングで先行公開する場合：ゲートの除外に `/availability` と `/api/availability` を追加（他は保護のまま）。

## 9. ルーティング（URL維持）

- `space-albe.com` の DNS を Cloudflare に向ける（ConoHa WING は origin のまま）。
- Workers ルート `space-albe.com/availability/*` → 本 Worker。その他パスは ConoHa WING が応答。
- 公開直前の作業。開発はこれを待たずに進行可能。

## 10. 段取り（実装フェーズ）

1. スキーマ追加＋既存9施設に area/use/room_group/cutoff/priority を投入（管理画面に入力欄）。
2. 判定ロジック拡張（free_windows・多室集計・next_open 前方スキャン）＋ユニットテスト。
3. `GET /api/availability`（全施設一括・キャッシュ）。
4. SSR `/availability/`（トークン/共通部品/法務/meta/モバイル/最終更新）。
5. `sitemap.xml`・ゲート除外。
6. 公開時：DNS→Cloudflare＋Workerルート設定。

## 11. 未決・要確認（実装中に詰める軽微事項）

- `area` / `use_category` の各施設の値（管理画面から入力可・初期はこちらで妥当値を投入）。
- `same_day_cutoff_hours` 初期値 **1**（＝開始1時間前まで）で開始、施設別に後から調整。
- デザイントークンを新サイトと**共有**する運用（本ページを正とするか、サイト側確定を待つか）。
