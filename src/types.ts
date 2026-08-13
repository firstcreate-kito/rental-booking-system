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
