# 公式サイト 料金連動ウィジェット（静的HTML用）

管理画面で変更した料金を、公式サイト（静的HTML）に自動反映するための埋め込み。
予約システムの公開API `/api/spaces` から最新料金を取得して差し込みます。

## 配布ファイル
- `https://booking.space-albe.com/assets/price-embed.js`（予約システムから配信・CORS対応済み）

## 使い方（HTMLに貼るだけ）

### 1) 全スペースの料金表を自動表示
```html
<div data-albe-price-table></div>
```
→ スペース名／平日／土日祝／最低利用／営業時間 の表を自動生成（平日=土日祝が同額のスペースは1列に集約）。

### 2) 個別の値を差し込む
```html
名駅フリースペースは <span data-albe-price="meieki-free" data-field="weekday"></span> から
```
`data-field` に指定できる値：
| field | 表示例 |
|---|---|
| `weekday` | ¥4,840/時（平日料金） |
| `weekend` | ¥7,260/時（土日祝料金） |
| `from` | ¥4,840/時（**開始料金＝平日・土日祝のうち最安の時間単価**。英語ページの「FROM」列に最適） |
| `rate` | ¥4,840/時〜（平日料金＋「〜」の簡易表記） |
| `min` | 3時間（最低利用。無ければ —） |
| `hours` | 08:00–22:00（営業時間） |
| `name` | スペース名 |

> `from` は「申込がお問い合わせのみ」のスペースや料金未設定のスペースでは自動的に「要問合せ」（英語では `Ask us`）と表示します。

### 2-a) 英語ページ用の表記（/時→/h、時間→hours、要問合せ→Ask us）
- **ページ全体を英語にする**場合は、スクリプトタグに `data-lang="en"` を付けます（下記4）。
- **個別に切り替える**場合は、その要素に `data-lang="en"` を付けます：
```html
Meieki Free Space — from <span data-albe-price="meieki-free" data-field="from" data-lang="en"></span>
```
→ `¥4,840/h` のように英語表記で表示されます（日本語ページはそのまま `/時`）。

英語ページの「FROM」列をシステムと連動させる例（`FROM` セルの中身を置き換え）：
```html
<span data-albe-price="albe-hall-nagoya"        data-field="from" data-lang="en">¥7,260/h</span>
<span data-albe-price="meieki-free"             data-field="from" data-lang="en">¥4,840/h</span>
<span data-albe-price="meieki-exercise"         data-field="from" data-lang="en">¥2,530/h</span>
<span data-albe-price="meieki-washitsu"         data-field="from" data-lang="en">¥3,080/h</span>
<span data-albe-price="meieki-piano-a"          data-field="from" data-lang="en">¥1,540/h</span>
<span data-albe-price="higashibetsuin-piano-24h" data-field="from" data-lang="en">¥1,650/h</span>
<span data-albe-price="kitaokazaki-warehouse"   data-field="from" data-lang="en">¥5,500/h</span>
```
- タグの中に書いた文字（例 `¥4,840/h`）は、APIに繋がらなかった時のフォールバック表示です（連動成功時は最新値で上書き）。
- `data-lang="en"` を各 `<span>` に付ければ、ページ全体を英語化しなくても英語表記になります。

### 3) 「予約する」ボタンのリンクを自動設定
```html
<a data-albe-link="meieki-free" class="btn">予約する</a>
```
→ そのスペースの予約画面（`/?space=...`）へのリンクが自動で入ります。

### 4) ページ末尾でスクリプトを1回読み込む
```html
<script src="https://booking.space-albe.com/assets/price-embed.js"
        data-api="https://booking.space-albe.com" data-lang="en" defer></script>
```
- `data-api` は参照先（予約システム）のURL。**本番なら上記のとおり**。
- `data-lang="en"` を付けるとページ全体が英語表記（`/h`・`hours`・`Ask us`）。日本語ページでは省略（既定 `ja`）。
- **テスト中**は、テスト用予約システムのURLに変えれば、そのデータで表示確認できます。

## スペースID一覧（公開スペース）
| ID | スペース |
|---|---|
| `albe-hall-nagoya` | アルベホール名古屋 |
| `meieki-free` | 名駅フリースペース |
| `meieki-exercise` | 名駅エクササイズスペース |
| `meieki-washitsu` | 名駅和室スペース |
| `meieki-piano-a` | 名駅防音室グランドピアノ練習室（A） |
| `meieki-piano-b` | 名駅防音室グランドピアノ練習室（B） |
| `higashibetsuin-piano-24h` | 東別院24hグランドピアノ音楽練習室 |
| `kitaokazaki-warehouse` | 北岡崎倉庫スペース |

> スペースが増減した場合の最新の一覧・IDは、公開API `GET /api/spaces` の `id` で確認できます。

## 動作の要点
- 料金は**ページ表示時に自動取得**。管理画面で料金を変えると、公式サイトの表示も次回読み込みで反映されます。
- 取得に失敗した場合は**何もしません**（静的に書いてある内容がそのまま残る）。保険として、タグの中に通常の文字（例：`¥4,840/時`）を書いておけば、万一APIに繋がらない時もその文字が表示されます。
- 表のデザインは最小限のCSSを自動適用。サイト側でクラス `.albe-price-table` を上書きして調整可能。
