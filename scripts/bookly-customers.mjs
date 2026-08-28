#!/usr/bin/env node
// Bookly顧客CSV ＋ 取り込みスロットJSON → 会員化ロースター（src/data/bookly-customers.json）を生成する。
//
// 使い方:
//   node scripts/bookly-customers.mjs <Customers.csv> [out.json] [cutoff=YYYY-MM-DD]
//   例) node scripts/bookly-customers.mjs ./Customers.csv src/data/bookly-customers.json 2026-08-30
//
// 仕様:
//   - 対象は「cutoff 以降の“顧客予約”（customer / customer_ticket）にメールで紐づく顧客」のみ。
//   - それ以外の顧客は破棄（＝新規登録に委ねる方針）。
//   - 紐付けキーはメール（小文字trim）。氏名・電話は顧客CSVから採用（会員レコードの補完用）。
import fs from 'node:fs';

function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else { if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
  }
  out.push(cur); return out;
}
const norm = (s) => String(s || '').trim().toLowerCase();

const csvPath = process.argv[2];
const outPath = process.argv[3] || 'src/data/bookly-customers.json';
const cutoff = process.argv[4] || '2026-08-30';
if (!csvPath) { console.error('usage: node scripts/bookly-customers.mjs <Customers.csv> [out.json] [cutoff]'); process.exit(1); }

// 取り込みスロット（既存の生成物）から、cutoff以降の顧客予約メールを集める
const { slots } = JSON.parse(fs.readFileSync('src/data/bookly-slots.json', 'utf8'));
const inScopeEmails = new Set();
for (const s of slots) {
  if ((s.category === 'customer' || s.category === 'customer_ticket') && s.date >= cutoff && norm(s.email)) {
    inScopeEmails.add(norm(s.email));
  }
}

// 顧客CSVから該当メールの氏名・電話を採用
const txt = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
const lines = txt.split(/\r?\n/).filter((l) => l.length);
const H = parseCsvLine(lines[0]);
const ci = (n) => H.findIndex((h) => h.replace(/^﻿/, '').trim() === n);
const iE = ci('Email'), iN = ci('Full name'), iP = ci('Phone');
const roster = new Map();
for (let i = 1; i < lines.length; i++) {
  const r = parseCsvLine(lines[i]);
  const e = norm(r[iE]);
  if (!e || !inScopeEmails.has(e) || roster.has(e)) continue;
  roster.set(e, { email: e, contactName: (r[iN] || '').trim(), phone: (r[iP] || '').trim() });
}

// 予約が有るのにCSVに居ないメール（設計上ゼロのはず）を警告
const missing = [...inScopeEmails].filter((e) => !roster.has(e));
const list = [...roster.values()].sort((a, b) => (a.email < b.email ? -1 : 1));
const meta = {
  generatedAt: new Date().toISOString(),
  cutoff,
  inScopeEmails: inScopeEmails.size,
  rosterSize: list.length,
  missingInCsv: missing, // 空配列であること
};
fs.writeFileSync(outPath, JSON.stringify({ meta, customers: list }, null, 2));
console.error(JSON.stringify(meta, null, 2));
console.error(`\n✔ ${list.length} customers → ${outPath}`);
