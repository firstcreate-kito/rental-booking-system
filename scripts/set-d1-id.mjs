#!/usr/bin/env node
/**
 * wrangler.jsonc の D1 database_id を書き換えるヘルパー。
 * 使い方: node scripts/set-d1-id.mjs <database_id>
 *   <database_id> は `wrangler d1 create albe_booking` の出力に含まれる UUID。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const id = process.argv[2];
if (!id || !/^[0-9a-f-]{30,40}$/i.test(id)) {
  console.error('使い方: node scripts/set-d1-id.mjs <database_id>');
  console.error('  <database_id> は `wrangler d1 create albe_booking` が表示する UUID です。');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'wrangler.jsonc');
const text = readFileSync(path, 'utf8');

const re = /("database_id"\s*:\s*)"[^"]*"/;
if (!re.test(text)) {
  console.error('wrangler.jsonc に database_id の項目が見つかりませんでした。');
  process.exit(1);
}
const next = text.replace(re, `$1"${id}"`);
writeFileSync(path, next);
console.log(`✓ wrangler.jsonc の database_id を ${id} に設定しました。`);
