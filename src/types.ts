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
  /** 新規予約の通知先（管理者メール）。未設定なら管理者通知は送らない */
  MAIL_ADMIN?: string;
  /** Google カレンダー連携（サービスアカウント）。両方セット時のみ有効 */
  GOOGLE_SA_EMAIL?: string;
  GOOGLE_SA_PRIVATE_KEY?: string;
  /** Stripe 決済（チケット購入）。SECRET_KEY と WEBHOOK_SECRET 両方セット時のみ有効 */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** PayPal 決済。CLIENT_ID と CLIENT_SECRET 両方セット時のみ有効。MODE は 'sandbox'(既定)/'live' */
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_MODE?: string;
  /** 決済完了後の戻り先ベースURL（未設定ならリクエスト元 origin を使用） */
  PUBLIC_BASE_URL?: string;
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
