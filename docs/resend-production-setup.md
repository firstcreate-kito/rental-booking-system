# 本番メール送信の設定（Resend ドメイン認証）

お客様への通知メールを、テスト用の `onboarding@resend.dev` から
**独自ドメイン `space-albe.com`（送信元 `rental@space-albe.com`）** に切り替える手順です。

> ドメイン認証をしないと、Resend アカウントの持ち主以外（＝実際のお客様）にメールが届きません。
> 公開前に必ず実施してください。

---

## パート1：Resend でドメインを追加

1. https://resend.com/domains にログイン
2. **「Add Domain」** → ドメインに `space-albe.com` を入力 → 追加
   - リージョンは近い方（Tokyo があれば Tokyo、無ければそのまま）でOK
3. 追加すると、設定すべき **DNSレコード一覧** が表示されます（値は自動生成）。
   だいたい以下の種類が出ます（**実際の値は必ず Resend の画面からコピー**してください）：
   - **MX**：ホスト名 `send`（例）／ 宛先 `feedback-smtp.***.amazonses.com`
   - **TXT（SPF）**：ホスト名 `send` ／ 値 `v=spf1 include:amazonses.com ~all`
   - **TXT（DKIM）**：ホスト名 `resend._domainkey` ／ 値 `p=…`（長い文字列）
   - **TXT（DMARC・任意）**：ホスト名 `_dmarc` ／ 値 `v=DMARC1; p=none;`

---

## パート2：DNS レコードを登録

`space-albe.com` のDNSを管理している場所（ドメイン取得業者／Cloudflare 等）の
管理画面で、パート1で表示された **レコードをそのまま追加**します。

- ホスト名（Name）と値（Value）は Resend の表示を**コピペ**する
- TXT値はダブルクォートで囲む必要がある業者もあります（画面の指示に従う）
- 反映（伝播）に数分〜最大48時間かかることがあります

登録が終わったら Resend の画面で **「Verify」** を押す → すべて緑（Verified）になれば完了。

---

## パート3：送信元アドレスをシステムに設定

Verified になったら、PC（PowerShell）で送信元を設定します。

```powershell
npx wrangler secret put MAIL_FROM
```
→ 入力値： `レンタルスペースALBE <rental@space-albe.com>`

（任意）返信先を別の受信箱にしたい場合のみ：
```powershell
npx wrangler secret put MAIL_REPLY_TO
```
→ 入力値： `rental@space-albe.com`
※送信元をそのまま `rental@space-albe.com` にする場合は返信もそこへ届くため、MAIL_REPLY_TO は不要です。

反映：
```powershell
npm run deploy
```

---

## 動作確認

1. **自分以外のメールアドレス**（携帯のフリーメール等）でテスト予約を1件入れる
2. そのアドレスに、送信元 `rental@space-albe.com` からメールが届けばOK
3. 迷惑メールに入っていないかも確認（DKIM/SPF が正しければ通常は受信箱に入ります）

`RESEND_API_KEY` はそのままで大丈夫です（ドメイン認証と `MAIL_FROM` の設定だけで本番送信になります）。
