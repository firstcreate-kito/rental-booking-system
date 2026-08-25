/**
 * Cloudflare Workers の環境バインディング型定義
 */
export interface Env {
  /** D1 データベース（wrangler.jsonc の binding: "DB"） */
  DB: D1Database;
  /** 実行環境識別子（development / production 等） */
  APP_ENV: string;
  /** 静的アセット（public/）を配信するバインディング */
  ASSETS: Fetcher;
  /** ベーシック認証（開発用ゲート）。両方セット時のみ有効化 */
  BASIC_AUTH_USER?: string;
  BASIC_AUTH_PASS?: string;
  /** メール送信（Resend）。RESEND_API_KEY と MAIL_FROM 両方セット時のみ送信 */
  RESEND_API_KEY?: string;
  /** 送信元。例: "レンタルスペースALBE <noreply@albe.jp>" */
  MAIL_FROM?: string;
  /** ステージングでも実メールを送りたいときだけ 'true'。既定（未設定）は送らない（安全装置）。 */
  STAGING_ALLOW_EMAIL?: string;
  /** 新規予約の通知先（管理者メール）。未設定なら管理者通知は送らない */
  MAIL_ADMIN?: string;
  /** 返信先（任意）。送信元を noreply@… にする場合に、返信先を実在の受信箱へ向ける */
  MAIL_REPLY_TO?: string;
  /** Google カレンダー連携（サービスアカウント）。両方セット時のみ有効 */
  GOOGLE_SA_EMAIL?: string;
  GOOGLE_SA_PRIVATE_KEY?: string;
  /** Stripe 決済（チケット購入）。SECRET_KEY と WEBHOOK_SECRET 両方セット時のみ有効 */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** コンビニ払いを本番で有効化（Stripeダッシュボード設定済みのとき 'true'）#67/#39 */
  STRIPE_KONBINI_ENABLED?: string;
  /** PayPal 決済。CLIENT_ID と CLIENT_SECRET 両方セット時のみ有効。MODE は 'sandbox'(既定)/'live' */
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_MODE?: string;
  /** 決済完了後の戻り先ベースURL（未設定ならリクエスト元 origin を使用） */
  PUBLIC_BASE_URL?: string;
  /** Googleログイン（OAuth/OIDC）。CLIENT_ID と CLIENT_SECRET 両方セット時のみ有効（#91） */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** LINEログイン（LINE Login v2.1 / OIDC）。CHANNEL_ID と CHANNEL_SECRET 両方セット時のみ有効（#91） */
  LINE_CHANNEL_ID?: string;
  LINE_CHANNEL_SECRET?: string;
  /**
   * データ保持ポリシー（#57）: 'true' のときのみ、7年経過した顧客の個人情報を
   * 実際に匿名化する。未設定・それ以外は「ドライラン」（対象件数のログのみ・変更しない）。
   */
  ANONYMIZE_ENABLED?: string;
  /**
   * 領収書/請求書のサーバー側PDF生成（Cloudflare Browser Rendering REST API）。
   * CF_ACCOUNT_ID と CF_BROWSER_API_TOKEN の両方をセットしたときのみ ?format=pdf でPDFを返す。
   * 未設定・失敗時はHTML表示（印刷→PDF保存）にフォールバックするため、既存挙動は壊れない。
   */
  CF_ACCOUNT_ID?: string;
  CF_BROWSER_API_TOKEN?: string;
  /**
   * デプロイされたコミット（短縮SHA）。Deploy ワークフローが `--var GIT_SHA:...` で
   * 注入する。ステージングと本番の「今動いているコード」を突き合わせるために使う（表示専用）。
   * 未設定なら不明として扱う。
   */
  GIT_SHA?: string;
}

/** 認証済み顧客（コンテキストに載る最小情報） */
export interface AuthCustomer {
  id: string;
  email: string;
  contactName: string;
  statusId: string;
  isRegistered: boolean;
}

/** 認証済み管理者 */
export interface AuthAdmin {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'manager' | 'staff';
}

/** Hono のコンテキストに載せる型 */
export type AppBindings = {
  Bindings: Env;
  Variables: {
    customer: AuthCustomer;
    admin: AuthAdmin;
  };
};
