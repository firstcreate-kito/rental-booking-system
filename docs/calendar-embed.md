# 施設カレンダー埋め込み（外部サイト用・#19）

外部サイト（例：名駅フリースペース `https://meiekifree.space-albe.com/` /
アルベホール名古屋 `https://albe-hall.com/`）に、**その施設だけの月間カレンダー**
（空き状況 ○△✕−）を貼り付けるためのウィジェットです。日付をクリックすると、
予約システムの予約画面（`booking.space-albe.com/?space=…&date=…`）が**新規タブ**で開きます。
決済・ログインは予約システム本体で安定動作するため、埋め込み側は「空きを見せて予約へ送る」役割に徹します。

- データは公開API `GET /api/spaces/:id/slots?month=YYYY-MM` を利用（管理画面の変更が自動反映）。
- 高さは**自動調整**（iframe が親へ `postMessage` で高さを通知）。
- スキーマ変更なし・読み取り専用。予約はすべて予約システム側で完結します。

---

## 貼り方（推奨：スクリプト＋div）

表示したい場所に `div` を1つ置き、ページ末尾でスクリプトを1回だけ読み込みます。

```html
<!-- カレンダーを表示したい場所 -->
<div data-albe-calendar="meieki-free"></div>

<!-- ページ末尾で1回だけ読み込む -->
<script src="https://booking.space-albe.com/assets/calendar-embed.js" defer></script>
```

`data-albe-calendar` にはスペースの **ID または slug** を指定します。

| 貼る値（ID） | 施設 |
|---|---|
| `meieki-free` | 名駅フリースペース |
| `albe-hall-nagoya` | アルベホール名古屋 |
| `meieki-exercise` | 名駅エクササイズ |
| `meieki-washitsu` | 名駅和室 |
| `meieki-piano-a` | 名駅防音室A |
| `meieki-piano-b` | 名駅防音室B |
| `higashibetsuin-piano-24h` | 東別院24hピアノ練習室 |

> 管理画面のスペース設定で独自スラッグを設定している場合は、その slug でも指定できます。

### 月を指定して開く（任意）

```html
<div data-albe-calendar="meieki-free" data-month="2026-10"></div>
```

### 複数施設を1ページに並べる

`div` を複数置くだけです（スクリプトの読み込みは1回でOK）。

```html
<div data-albe-calendar="meieki-free"></div>
<div data-albe-calendar="albe-hall-nagoya"></div>
<script src="https://booking.space-albe.com/assets/calendar-embed.js" defer></script>
```

---

## 貼り方（かんたん：iframe直貼り）

スクリプトを使わず iframe を直接貼ることもできます。**高さは固定**になります
（自動調整が必要なら上記のスクリプト方式を推奨）。

```html
<iframe
  src="https://booking.space-albe.com/embed/calendar?space=meieki-free"
  style="width:100%;max-width:560px;height:520px;border:0"
  loading="lazy"
  title="ALBE 空き状況カレンダー"></iframe>
```

---

## パラメータ

`GET https://booking.space-albe.com/embed/calendar`

| クエリ | 必須 | 説明 |
|---|---|---|
| `space` | ✅ | スペースの ID または slug（例：`meieki-free`） |
| `month` | 任意 | 初期表示月 `YYYY-MM`（省略時は当月・JST） |

- 記号の意味：**○** 空きあり / **△** 商談中 / **✕** 満室 / **−** 休業。
- 過去月へは戻れません（`‹` は当月で無効化）。
- 予約可能期間より先でも「閲覧可能期間内（最大180日）」の日はクリックで予約画面へ誘導します。
  実際に予約できるか（お問い合わせのみ施設か等）は予約システム本体で判定されます。

---

## 仕組み（メンテ向け）

- ルート：`src/routes/embed.ts` の `embedCalendar`（`GET /embed/calendar` に登録・`src/index.ts`）。
  施設の解決（slug/id→id）だけサーバー側で行い、自己完結HTML（インラインCSS/JS）を返す。
  `Cache-Control: public, max-age=120`。
- ローダー：`public/assets/calendar-embed.js`（`[data-albe-calendar]` に iframe を注入し、
  子からの `{albeCalHeight}` を受けて高さを自動調整）。
- 表示データは既存の公開API `GET /api/spaces/:id/slots?month=` をそのまま利用（追加のDB変更なし）。
