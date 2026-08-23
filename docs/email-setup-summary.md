# メール送信 設定サマリー（お問い合わせフォーム等への引き継ぎ用）

WEBサイトのお問い合わせフォームなど、**新しくメール送信を追加する際に再利用**できるよう、
現在の送信基盤をまとめたものです。ドメイン `space-albe.com` は認証済みで、
差出人 `rental@space-albe.com` から SPF/DKIM/DMARC すべて PASS の状態で送れます。

---

## 1. 送信基盤の概要

| 項目 | 値・内容 |
|---|---|
| 送信サービス | **Resend**（https://resend.com） ※内部は Amazon SES |
| リージョン | Tokyo（ap-northeast-1） |
| 認証済みドメイン | **space-albe.com**（Resend で Verified） |
| 差出人（From） | **レンタルスペースALBE <rental@space-albe.com>** |
| 返信先（任意） | 未設定でOK（From が実在の受信箱のため返信はそのまま届く） |
| 受信（メールボックス） | `rental@space-albe.com` は **さくら**サーバーで受信（ルートMX = firstcreate6.sakura.ne.jp）。Resendは送信専用で受信には関与しない |
| 認証結果 | SPF=PASS / DKIM=PASS / DMARC=PASS（実測確認済み） |

## 2. DNS（Cloudflare・space-albe.com）に入っている送信用レコード

Resend の Auto configure で追加済み。**既存のさくらメール（受信）とは別名なので共存**しています。

| Type | Name | 用途 |
|---|---|---|
| MX | `send` | Resend（SES）の返送先 → feedback-smtp.ap-northeast-1.amazonses.com |
| TXT | `send` | SPF：`v=spf1 include:amazonses.com ~all` |
| TXT | `resend._domainkey` | DKIM 署名鍵（Resend） |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:rental@space-albe.com` |

※ 既存の受信用（`space-albe.com` MX = さくら、`default._domainkey` 等）は**触っていません**。

## 3. 予約システムでの送信方法（参考：同じやり方で再利用可能）

Cloudflare Workers から Resend の HTTP API を叩いています（`src/lib/email.ts` の `sendEmail`）。

- エンドポイント：`POST https://api.resend.com/emails`
- ヘッダ：`Authorization: Bearer <RESEND_API_KEY>` / `Content-Type: application/json`
- ボディ（JSON）：`{ from, to, subject, html, text, reply_to? }`
- 認証情報は Cloudflare Secret に保存：`RESEND_API_KEY` / `MAIL_FROM`（＝上記 From）/ 任意 `MAIL_REPLY_TO`

## 4. お問い合わせフォームで再利用する方法（2案）

お問い合わせフォームは **WordPress（さくら）側**にあるため、下記いずれかで同じ送信基盤を使えます。

### 案A：WordPress プラグインから Resend で送る（サイト内で完結・おすすめ）
- **WP Mail SMTP** 等のプラグインを入れ、送信を **Resend（SMTP もしくは API）** に設定
- 差出人を **`rental@space-albe.com`**、宛先（問い合わせ通知先）を **`rental@space-albe.com`** に
- ドメインは認証済みなので、そのまま SPF/DKIM/DMARC が通る
- Resend の API キーが必要（既存を使うか、Resend で新規発行）

### 案B：予約システム（Worker）に問い合わせ送信APIを追加し、WPフォームから送信
- 予約システムに `POST /api/contact` を新設し、内部で `sendEmail`（Resend）を再利用
- WordPress のフォームからその API に送信（CORS 許可が必要）
- 既存の送信コード・認証をそのまま流用できるが、**現在サイトは Basic 認証中**のため
  `/api/contact` を Basic 認証の除外対象にする必要がある（Webhookと同様の除外）
- スパム対策（ハニーポット・レート制限）を合わせて実装するのが望ましい

## 5. 引き継ぎ時のチェックポイント
- 差出人は必ず **`@space-albe.com`**（認証済みドメイン）にする。`@gmail.com` 等の他社ドメインを From にすると DMARC で弾かれやすい
- 問い合わせの**受信（管理者への通知先）**は `rental@space-albe.com`（さくら受信）でOK
- お客様への自動返信を送る場合も、From は `rental@space-albe.com` を使う
- 送信元ドメインを別サブドメイン（例：送信専用）に分けたい場合は、Resend に別ドメインとして追加し DNS を足す（現状は不要）
