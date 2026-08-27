# お問い合わせフォーム 連携仕様（公式サイト → 予約システム）

- **対象**: 公式サイト `https://space-albe.com/contact/` のお問い合わせフォーム送信先
- **提供API**: `POST /api/contact`（予約システム側で用意）
- **作成日**: 2026-08-27
- **関連**: `/api/viewing`（見学申込）と同じ流儀。実装は `src/routes/contact.ts` / `src/lib/email.ts`（`contactReceivedEmail` / `adminContactEmail`）

> この資料は「WEBサイト側の担当者に渡す連携情報」です。サイトのフォームから、この1本のAPIに JSON を POST すれば、担当者宛＋お客様への控えメールが送られます。

---

## 1. エンドポイント

| 環境 | URL |
|---|---|
| **本番** | `POST https://booking.space-albe.com/api/contact` |
| **確認用（ステージング）** | `POST https://albe-booking-api-staging.rental-space-albe.workers.dev/api/contact` |

- `Content-Type: application/json`
- 認証不要（公開エンドポイント。公開前のBasic認証ゲートも通過するよう許可済み）。

---

## 2. リクエスト（JSON）

```json
{
  "type":    "quote",              // ご用件（下記のいずれか。未知の値は other 扱い）
  "space":   "sakae-chapel",       // ご希望の施設（施設ID。未選択なら空でOK）
  "date":    "2026-12-24",         // ご利用予定日（任意）
  "days":    "2",                  // 利用日数（任意）
  "name":    "山田 太郎",           // お名前【必須】
  "company": "株式会社○○",         // 会社名・団体名（任意）
  "mail":    "taro@example.com",   // メールアドレス【必須・形式チェックあり】
  "tel":     "0521234567",         // お電話番号（任意）
  "body":    "12月に30名で…",       // お問い合わせ内容【必須】
  "agree":   "on",                 // プライバシーポリシーへの同意【必須】
  "lang":    "ja",                 // "ja" または "en"（任意・既定 ja）
  "page":    "https://space-albe.com"  // 送信元ページ（任意）
}
```

### フィールド定義

| キー | 必須 | 説明 |
|---|---|---|
| `name` | ✅ | お名前 |
| `mail` | ✅ | メールアドレス（形式が不正なら 400） |
| `body` | ✅ | お問い合わせ内容 |
| `agree` | ✅ | 同意。`"on"` を送る（`true` / `1` / `yes` も可）。未同意は 400 |
| `type` | 任意 | ご用件。下表の値。**未知の値は自動で `other`** に丸める |
| `space` | 任意 | 施設ID。**実在すれば施設名に解決**してメール表示（未知IDは値のまま・空は施設欄なし） |
| `date` | 任意 | ご利用予定日 |
| `days` | 任意 | 利用日数 |
| `company` | 任意 | 会社名・団体名 |
| `tel` | 任意 | お電話番号 |
| `lang` | 任意 | `"en"` のとき**お客様への控えを英語**で送信（既定 `ja`。担当者宛は常に日本語） |
| `page` | 任意 | 送信元ページURL（担当者宛メールに参考表示） |

### `type`（ご用件）の値

| 値 | 日本語ラベル | English |
|---|---|---|
| `reserve` | ご予約について | Reservation |
| `quote` | お見積り | Quote / Estimate |
| `multi` | 複数施設のご相談 | Multiple spaces |
| `long` | 長期利用のご相談 | Long-term use |
| `equipment` | 設備・備品について | Equipment / Facilities |
| `invoice` | お支払い・請求書について | Payment / Invoice |
| `partner` | 提携・法人契約について | Partnership / Corporate |
| `other` | その他 | Other |

---

## 3. レスポンス

| 状況 | ステータス | ボディ |
|---|---|---|
| 成功 | **`201`** | `{"ok":true}` |
| 入力不備（必須欠落・メール形式・未同意） | `400` | `{"error":"..."}` |
| JSON不正 | `400` | `{"error":"invalid JSON body"}` |

- **サイト側は「2xx＝送信成功」** として扱ってください（それ以外は「送信できませんでした」を表示）。
- **メール送信は非同期**（受理後に裏側で送信）。送信基盤に一時不調があっても**フォーム送信自体は 201** を返すため、サイト側の15秒打ち切りに収まります。
- `400` の `error` はサイト側の判断材料に使えますが、文面はそのまま表示せず、サイト側の定型メッセージ（例：「入力内容をご確認ください」）を出すことを推奨します。

---

## 4. 送信されるメール

| 宛先 | 件名 | 内容 |
|---|---|---|
| **担当者** | 「【お問い合わせ】{用件}｜{お名前} 様」 | 用件・施設・日程・お名前・会社名・メール・電話・本文・送信元ページ。返信先としてお客様メールを明記。施設を指定した場合は**その施設の通知先＋本部**、未指定なら**本部（`rental@space-albe.com`）**へ |
| **お客様（控え）** | 「【レンタルスペースALBE】お問い合わせを受け付けました」（`lang=en` は英語件名） | 受付内容の控え。`lang=en` のときは英語本文 |

---

## 5. CORS

- 既存の `/api/*`（`/api/viewing` 等）と同じ設定（**全オリジン許可**）。
- `https://space-albe.com`（本番）／`http://stg.space-albe.com`（確認用）いずれからでも、`POST` とプリフライト（`OPTIONS`）が通ります。**サイト側・システム側とも追加設定は不要**。

---

## 6. 実装例（サイト側 JavaScript）

```js
async function submitContact(payload) {
  const API = 'https://booking.space-albe.com/api/contact'; // 確認時はステージングURL
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000); // サイト側15秒打ち切り
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (res.ok) {
      // 送信できました（サンクスページ／完了表示へ）
    } else {
      // 送信できませんでした（入力確認をご案内）
    }
  } catch (e) {
    // タイムアウト・通信エラー → 送信できませんでした
  } finally {
    clearTimeout(timer);
  }
}
```

---

## 7. 確認手順・注意

1. **サイト側の疎通確認**：`http://stg.space-albe.com` のフォームから**確認用エンドポイント**へPOSTし、**`201`が返ればOK**（フォームの成功表示まで確認できます）。
2. **メール文面の確認**：**ステージングはメール送信を停止**しているため、確認環境では実メールは飛びません。**本番反映後に1件テスト送信**して、担当者宛・お客様控えの文面をご確認ください。
3. 迷惑メール対策：お客様への控えが届かない場合は迷惑メールフォルダをご確認いただく案内をフォーム完了画面に添えると親切です。

---

## 8. 施設ID（`space` に入れる値）の例

`space` はシステムのスペースIDです。主なID（抜粋）:

| 施設 | ID |
|---|---|
| 名駅防音室グランドピアノ練習室（A） | `meieki-piano-a` |
| 名駅防音室グランドピアノ練習室（B） | `meieki-piano-b` |
| 東別院防音室24時間グランドピアノ音楽練習室 | `higashibetsuin-piano-24h` |

- 最新の一覧は公開API `GET /api/spaces`（`id` と `name`）で取得できます。フォームのプルダウンをこのAPIから生成すると、施設の増減に自動追従できます。
- 未知IDや空でもエラーにはならず、メールにはその値（または施設欄なし）で表示されます。

---

## 9. 変更・カスタマイズ

- **メール文面**：日本語・英語とも `src/lib/email.ts` の `contactReceivedEmail` / `adminContactEmail` で変更可能。サイト側で用意した文面案があれば差し替えます。
- **担当者宛先**：本部は環境変数 `MAIL_ADMIN`、施設別は管理画面「スペース設定 → 通知先メールアドレス」で設定。
