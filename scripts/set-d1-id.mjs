#!/usr/bin/env node
/**
 * wrangler.jsonc の D1 database_id を書き換えるヘルパー。
 *
 * 使い方:
 *   本番:       node scripts/set-d1-id.mjs <database_id>
 *   ステージング: node scripts/set-d1-id.mjs <database_id> --staging
 *
 * <database_id> は `wrangler d1 create <名前>` の出力に含まれる UUID。
 *   本番       … `wrangler d1 create albe_booking`         → database_name "albe_booking"
 *   ステージング … `wrangler d1 create albe_booking_staging` → database_name "albe_booking_staging"
 *
 * 対象の database_id は database_name で見分けるため、本番とステージングを
 * 取り違えて上書きすることはない。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const isStaging = args.includes('--staging');
const id = args.find((a) => !a.startsWith('--'));

if (!id || !/^[0-9a-f-]{30,40}$/i.test(id)) {
  console.error('使い方:');
  console.error('  本番      : node scripts/set-d1-id.mjs <database_id>');
  console.error('  ステージング: node scripts/set-d1-id.mjs <database_id> --staging');
  console.error('  <database_id> は `wrangler d1 create ...` が表示する UUID です。');
  process.exit(1);
}

// 書き換え対象の database_name（本番 / ステージング）
const dbName = isStaging ? 'albe_booking_staging' : 'albe_booking';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'wrangler.jsonc');
const text = readFileSync(path, 'utf8');

// database_name が一致するブロック内の database_id だけを置換する。
// "albe_booking" の閉じ引用符まで含めて照合するため、"albe_booking_staging" とは混同しない。
const re = new RegExp(
  `("database_name"\\s*:\\s*"${dbName}"[\\s\\S]*?"database_id"\\s*:\\s*)"[^"]*"`,
);
if (!re.test(text)) {
  console.error(`wrangler.jsonc に database_name "${dbName}" の項目が見つかりませんでした。`);
  process.exit(1);
}
const next = text.replace(re, `$1"${id}"`);
writeFileSync(path, next);
console.log(
  `✓ wrangler.jsonc の database_id（${dbName}${isStaging ? ' / ステージング' : ' / 本番'}）を ${id} に設定しました。`,
);
