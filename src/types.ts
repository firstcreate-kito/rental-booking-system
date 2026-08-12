/**
 * Cloudflare Workers の環境バインディング型定義
 */
export interface Env {
  /** D1 データベース（wrangler.jsonc の binding: "DB"） */
  DB: D1Database;
  /** 実行環境識別子（development / production 等） */
  APP_ENV: string;
}

/** Hono のコンテキストに載せる型 */
export type AppBindings = {
  Bindings: Env;
};
