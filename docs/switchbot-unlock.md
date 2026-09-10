# SwitchBotロック連携（#123・スペース別・A案＝「解錠のみ」）

予約とSwitchBotスマートロックを連動させ、**利用開始時刻に自動で解錠**する機能です。

## 方針（重要）

- **解錠だけを自動化し、施錠は自動で行いません（A案）。**
  - 理由：主催者が退室時に扉を開けたままにすることがあり、開いた扉に施錠コマンドを送ると
    SwitchBotロック（後付けのサムターン回転式）が空振り・詰まり（JAMMED）を起こす危険があるため。
  - 夜間の施錠は従来どおり運用（人手／既存の別手段）で行います。
- **スペースごとに方式を選べます。**
  - `off` … 連携しない（既定）
  - `auto` … 利用開始時刻に自動解錠（名駅フリースペースはこれ）
  - `button` … 自動解錠せず、管理画面の「今すぐ解錠」だけ使う（手動運用）
- まずは **名駅フリースペース**（`meieki-free`）で `auto` を **ステージングで試験運用**します。

## 仕組み

- Cron（5分毎 `*/5 * * * *`）で `runSwitchbotAutoUnlock` が動作。
- `mode=auto` かつ `switchbot_lock_device_id` が設定されたスペースの、
  当日の確定予約（`bookings.status != 'cancelled'` / `booking_groups.status = 'confirmed'`）を対象に、
  **開始 lead 分前 〜 開始+30分**（取りこぼし救済）の窓で **一度だけ** 解錠します。
- 重複解錠の防止：`switchbot_unlock_log` に `slot_key='YYYY-MM-DD HH:MM'` と `trigger='auto'/status='success'` を記録し、
  既に成功していれば再送しません。
- `lead`（前倒し分）はスペースごとに設定可（既定5分）。

## セットアップ手順

### 1. トークン/シークレットの投入（GitHub Secrets 経由・PC不要）

SwitchBotアプリ →「プロフィール」→「設定」→「アプリバージョン」を10回タップ →
「開発者向けオプション」から **トークン** と **クライアントシークレット** を取得します。

- **ステージング**：GitHub → Settings → Secrets に
  - `SWITCHBOT_TOKEN_STAGING`
  - `SWITCHBOT_SECRET_STAGING`
  を登録 → GitHub → Actions →「Staging secrets」を実行（`redeploy=yes`）。
- **本番**：`SWITCHBOT_TOKEN_PROD` / `SWITCHBOT_SECRET_PROD` を登録 →「Production secrets」を `YES-PRODUCTION` で実行。
  - SwitchBotのトークンは環境で分かれないため、ステージングと本番で同じ値でも構いません。
    ただし**ステージングでは操作対象を「テスト用の deviceId」に限定**し、本番のロックを触らないでください。

> ⚠️ トークン/シークレットは**チャットや管理画面に貼らない**でください（GitHub Secrets にのみ登録）。

### 2. deviceId の設定（管理画面）

1. 管理画面 →「スペース管理」→ 対象スペースを編集。
2. 「SwitchBotロック連携」セクションで **「デバイス一覧を取得」** を押す。
3. `deviceType` が `Smart Lock` / `Smart Lock Pro` の行の **「このロックを使う」** を押す（deviceIdが入力欄に入る）。
4. **解錠方式**を選ぶ（名駅フリースペースは `自動解錠`）。必要なら**前倒し分**を調整（既定5分）。
5. **保存**。

### 3. 動作確認

- 「**今すぐ解錠（テスト）**」ボタンで、保存済み deviceId に対して即時に解錠を試せます（施錠はしません）。
- 「**解錠ログを表示**」で、自動解錠・手動・テストの履歴（成功/失敗）を確認できます。

> **ステージングでの注意**：ステージングは既定で自動Cronを止めています（`wrangler.jsonc` の `env.staging.triggers.crons=[]`）。
> そのため**自動解錠（auto）はステージングでは自動発火しません**。ステージングでは
> 「今すぐ解錠（テスト）」ボタンで SwitchBot 接続と deviceId を確認するのが基本です。
> 自動解錠の時刻挙動まで検証したい場合は、一時的に staging の `crons` を本番と同じ
> `["*/5 * * * *", ...]` にしてデプロイ→検証→元に戻す運用にしてください（他のCron通知が飛ぶ点に注意）。
> 自動解錠の「時刻窓（開始lead分前〜開始+30分）」「二重解錠しない」ロジック自体は
> `test/switchbot.test.ts` で固定・検証済みです。

## 対応関係

| スペース | ID | 想定方式 |
|---|---|---|
| 名駅フリースペース | `meieki-free` | `auto`（試験運用の起点） |
| その他 | — | 運用を見て `auto` / `button` を選択 |

## 将来対応（本実装では未対応）

- `passcode` 方式（SwitchBot Keypad に予約ごとの暗証番号を発行）。`switchbot_keypad_device_id` の枠だけ先行して用意済み。
- お客様自身がマイページ等から解錠する `button` の顧客向けUI（現状は管理画面からの手動解錠のみ）。
