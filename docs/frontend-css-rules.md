# 顧客向けフロントの CSSコーディングルール（予約システム側）

- 対象: `public/index.html` `mypage.html` `tickets.html` `viewing.html` `reset.html`
  `pay-complete.html` と SSRページ（`src/lib/availability-page.ts` `booking-change-page.ts`）。
- 管理画面（`public/admin.html`）は別系統（`docs/admin-ui-rules.md`）。
- WEBサイトと共有する原則は `_handover/1_コーディングルール`（サイト側）に準拠する。
  本書は「予約システム側で実装した内容」と「こちらで追加した要件」の記録。

---

## 0. 大原則
- **CSSフレームワークを使わない**（素のCSS・ビルド工程なし）。
- **色・余白・角丸・文字・入力欄・バッジは共通トークン `public/assets/tokens.css` に集約**し、
  各ページ・HTMLに直書きしない（R13-11）。サイトと予約システムで同じ `tokens.css` を読む。
- モバイルファースト（スマホを先に書き、`@media (min-width)` でPCを足す）。
- アクセシビリティ（WCAG AA・色＋記号＋文字の多重表現）。

---

## 1. 入力欄（R13-7〜R13-11・実装済み）

入力欄の共通スタイルは **`tokens.css` に1か所だけ**定義する（下記）。各ページで
`input`/`select`/`textarea` に枠色・文字サイズ等を直書きしない。

- **R13-7 枠のコントラスト**: 枠は背景に対して 3:1 以上（WCAG 1.4.11）。トークン **`--field`（#8a867e）** を使う。
  従来の `--line-2`（#d8d5ce）は白に 1.47:1 で見えなかった。面は `--wash` でわずかに沈める。
- **R13-8 サイズ**: 文字 **16px以上**・高さ **44px以上**（16px未満だと iOS Safari が触れた瞬間に拡大するため）。
- **R13-9 フォーカス**: `outline: 2px solid var(--key); outline-offset: 2px;`。`outline: none` で消さない。
- **R13-10 ラベル**: ラベルは欄の外に置く。プレースホルダは記入例のみ。
- **R13-11 集約**: 入力欄CSSは `tokens.css` の1か所。HTMLへの直書き（`style=`）や各ページ `<style>` での再定義をしない。

```css
/* tokens.css（抜粋） */
--field: #8a867e;   /* 入力欄の枠。白/--wash に対して 3:1 以上（サイトと同値） */

input:not([type=checkbox]):not([type=radio]):not([type=file])…, select, textarea {
  width:100%; box-sizing:border-box; min-height:var(--tap)/*44px*/;
  padding:10px 12px; font-size:16px; color:var(--ink);
  background:var(--wash); border:1px solid var(--field); border-radius:var(--r);
}
…:focus { outline:2px solid var(--key); outline-offset:2px; border-color:var(--key); }
```

- 対象外: チェックボックス／ラジオ／ファイル／レンジ等（枠線ルールはセレクタで除外）。
  ただしチェックボックス／ラジオの**大きさ**は R13-12 で別途 `tokens.css` に集約。
- `--field` は **WEBサイト側 `_handover/tokens.css` の `--field`（#8a867e）と同値**（両サイト統一）。

### R13-12 チェックボックス／ラジオの大きさ（実装済み）

ブラウザ既定のチェックボックス／ラジオは小さく、スマホで押し間違い・見落としが起きやすい
（特に「お支払い方法」「規約同意」）。大きさは **`tokens.css` の1か所**に集約する。

- **基準サイズはオプション選択UI（`.opt-row` の 22px）に合わせる**。PC=22px、
  **スマホ（≤640px）は 28px（約2倍）**に拡大してタップしやすくする。
- オン時の色は `accent-color: var(--key)`（ブランド色）で統一。
- **各HTML／JSで `style="width:auto"` 等の個別サイズ指定をしない**（この共通指定が効かなくなる）。
  必要なのは余白・整列だけ（`margin` / `align-items`）に留める。

```css
/* tokens.css（抜粋・R13-12） */
input[type=checkbox], input[type=radio] {
  width: 22px; height: 22px; accent-color: var(--key);
  cursor: pointer; vertical-align: middle; flex: 0 0 auto;
}
@media (max-width: 640px) {
  input[type=checkbox], input[type=radio] { width: 28px; height: 28px; }
}
```

- 適用範囲は顧客向け・管理画面（`admin.html`）を含む**全ページ共通**（`tokens.css` を読む全画面）。
- 選択肢が「行」になるUI（支払い方法・規約同意）は、`.opt-row` に倣って
  行に余白＋区切り線を付け、行全体を押しやすいタップ領域にする。

---

## 2. 【追加要件】必須／任意バッジ（.req / .opt）

WEBサイトのお問い合わせフォームに合わせ、必須・任意は**バッジ表示**にする（`*` は使わない）。
共通クラスを `tokens.css` に定義済み。

```css
.req { background:var(--full); color:#fff; }               /* 必須：赤の塗り */
.opt { background:var(--wash); color:var(--ink-3);
       border:1px solid var(--line-2); }                    /* 任意：淡いグレー */
/* 共通: font-size:11px; padding:3px 7px; border-radius:5px; margin-left:6px; */
```

使い方（ラベルの外・末尾に置く）:
```html
<label>メールアドレス <span class="req">必須</span></label>
<label>会社名 <span class="opt">任意</span></label>
```

- これは予約システム側で追加した共通部品。**サイト側の共有ルールにも同内容を追記推奨**。

---

## 3. その他の共通ルール（既存）
- 本文（body）を横スクロールさせない。幅広の表・カレンダーは要素内スクロール、またはスマホは縦組みカード。
- カレンダーの7列は `repeat(7, minmax(0,1fr))`（狭幅で見切れさせない）。
- モーダルは追従ヘッダーより前面（`z-index`）に出し、`max-height:100dvh` ＋内部スクロールで見出しから全体を表示。
- タップ領域は最小44px。操作はテキストリンクではなくボタン。
