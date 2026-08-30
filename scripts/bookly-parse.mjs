#!/usr/bin/env node
// Bookly CSV → 新システム取り込み用の正規化スロットJSON を生成する（公開切替の予約移行 / #移行）。
//
// 使い方:
//   node scripts/bookly-parse.mjs <入力CSVディレクトリ> [出力JSONパス]
//   例) node scripts/bookly-parse.mjs ./bookly-csv src/data/bookly-slots.json
//
// 仕様:
//   - 対象は「現在Booklyを使っている8スペース」のみ（下表 STAFF_MAP）。それ以外は除外。
//   - OTA（スペースマーケット/インスタベース）行は除外（自己復旧するため）。
//   - (平日)/(土日祝)/2か月以上先予約/パック等の表記ゆれは1スペースに集約。
//   - 同一 (スペース, 開始日時) は1枠に重複排除（顧客行のラベルをブロックより優先）。
//   - endTime = Appointment date + Duration(分)。日跨ぎは検出して警告（8スペースでは発生しない想定）。
//   - 出力は「枠のみ」（氏名・料金・メール等の明細は含めない）。ラベルはカレンダー表示用に残す。
//
// 注意: 本番投入前に「全期間の正規CSV」で再生成すること。
import fs from 'node:fs';
import path from 'node:path';

// Bookly Staff名（表記ゆれ含む）→ 新システムの spaceId
const STAFF_MAP = [
  [/^アルベホール名古屋/, 'albe-hall-nagoya'],
  // 「【平日月曜〜金曜限定 8:00~13:00パック】名駅エクササイズスペース」は名称にエクササイズを含むが
  // 実体はアルベホール名古屋の予約（同一予約が複数リスティングに相乗り）。エクササイズと混在させないため
  // アルベホール側へ集約する（※必ず下の素の「名駅エクササイズスペース」ルールより前に置く）。
  [/パック】名駅エクササイズスペース/, 'albe-hall-nagoya'],
  [/名駅エクササイズスペース/, 'meieki-exercise'], // 素の「名駅エクササイズスペース／◯時間」等＝実施設の予約のみ
  [/^名駅和室スペース/, 'meieki-washitsu'],
  [/^名駅フリースペース/, 'meieki-free'],
  [/^東別院防音室24時間グランドピアノ練習室/, 'higashibetsuin-piano-24h'],
  [/^名駅防音室A/, 'meieki-piano-a'],
  [/^名駅防音室B/, 'meieki-piano-b'],
  [/^北岡崎倉庫スペース/, 'kitaokazaki-warehouse'],
  // 追加移行（当初は対象外にしていたが Bookly で予約を受けていたため取り込む）。
  // spaceId は本番D1の実スペースID（/api/spaces で確認済み）。
  [/^栄チャペルスペース/, '0ccfadae-4f59-427d-b5b6-4bdfd3fcd470'],
  [/^栄神殿スペース/, '6962febb-0538-4b8c-b04c-7e93285e4386'],
];

function mapSpace(staff) {
  for (const [re, id] of STAFF_MAP) if (re.test(staff)) return id;
  return null; // 対象外スペース
}

function isOTA(service) {
  return /スペースマーケット|インスタベース|予約ID:/.test(service || '');
}

// 「YYYY-MM-DD HH:MM:SS」→ {date:'YYYY-MM-DD', start:'HH:MM'}
function parseDateTime(s) {
  const m = String(s || '').trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return { date: m[1], start: `${m[2]}:${m[3]}` };
}

function addMinutes(date, hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + Number(minutes || 0);
  const endH = Math.floor(total / 60);
  const endM = total % 60;
  const crossesDay = endH >= 24;
  const hh = String(endH % 24).padStart(2, '0');
  const mm = String(endM).padStart(2, '0');
  return { end: `${hh}:${mm}`, crossesDay };
}

// 最小CSVパーサ（ダブルクオート対応・改行はレコード内では扱わない前提＝Bookly出力は1行1レコード）
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function categorize(email, service) {
  const svc = service || '';
  if (email && email.trim()) return svc.includes('チケット専用') ? 'customer_ticket' : 'customer';
  if (svc.startsWith('【予約完了】')) return 'mirror';
  return 'block';
}

// Service末尾の半角括弧 "(...)" からオプションを配列 [{name, quantity}] で抽出。
//   例) "…／3時間 (8 × 椅子, テーブル 180㎝×60㎝, ホワイトボード , ラグ)"
//     → [{name:'椅子',quantity:8},{name:'テーブル 180㎝×60㎝',quantity:1},{name:'ホワイトボード',quantity:1},{name:'ラグ',quantity:1}]
function parseOptions(service) {
  const m = String(service || '').match(/\(([^()]*)\)\s*$/); // 末尾の半角(...)。（平日）等の全角は対象外
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const q = item.match(/^(\d+)\s*[×xX]\s*(.+)$/); // 「8 × 椅子」→ 数量8・名前椅子
      return q ? { name: q[2].trim(), quantity: Number(q[1]) } : { name: item, quantity: 1 };
    });
}

// Payment欄から合計金額（円）を取り出す。 "¥14,520 Stripe Completed" / "¥0 of ¥33,000 Local Pending" 等。
function parseAmount(payment, priceCol) {
  const p = String(payment || '');
  const ofm = p.match(/of\s*¥\s*([\d,]+)/); // 「¥0 of ¥33,000」→ 合計は 33,000
  if (ofm) return Number(ofm[1].replace(/,/g, ''));
  const m = p.match(/¥\s*([\d,]+)/);
  if (m) return Number(m[1].replace(/,/g, ''));
  const pc = String(priceCol || '').match(/¥\s*([\d,]+)/);
  return pc ? Number(pc[1].replace(/,/g, '')) : 0;
}

// カレンダー表示用ラベル（明細ではなく短い見出し）
function makeLabel(cat, name, service) {
  const svc = (service || '').replace(/^【予約完了】\s*/, '').trim();
  if (cat === 'customer' || cat === 'customer_ticket') {
    const nm = (name || '').replace(/\s+/g, ' ').trim();
    return nm ? `予約 ${nm}` : (svc || '予約');
  }
  // block / mirror: サービス欄の見出しをそのまま（ブロック/チア 田中様/決 XINN 等）
  return svc || 'ブロック';
}

function main() {
  const inDir = process.argv[2];
  const outPath = process.argv[3] || 'src/data/bookly-slots.json';
  if (!inDir) {
    console.error('usage: node scripts/bookly-parse.mjs <csv-dir> [out.json]');
    process.exit(1);
  }
  const files = fs.readdirSync(inDir).filter((f) => /\.csv$/i.test(f)).sort();
  const bySlot = new Map(); // key: spaceId|date|start
  const warnings = [];
  let raw = 0, otaSkip = 0, offScope = 0;

  for (const f of files) {
    const text = fs.readFileSync(path.join(inDir, f), 'utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const header = parseCsvLine(lines[0]);
    const col = (name) => header.indexOf(name);
    const colPrefix = (prefix) => header.findIndex((h) => h.startsWith(prefix)); // 「（必須）」付き列名対策
    const iDate = col('Appointment date');
    const iStaff = col('Staff');
    const iName = col('Customer name');
    const iPhone = col('Customer phone');
    const iEmail = col('Customer email');
    const iSvc = col('Service');
    const iDur = col('Duration');
    const iId = col('ID');
    const iPay = col('Payment');
    const iPrice = col('Price');
    const iEvent = col('イベント名');
    const iPurpose = colPrefix('ご利用目的');
    const iHead = colPrefix('ご利用人数');
    const iRepeat = col('過去のご利用実績');
    for (let li = 1; li < lines.length; li++) {
      const row = parseCsvLine(lines[li]);
      if (!row[iId] || !row[iId].trim()) continue;
      raw++;
      const staff = row[iStaff] || '';
      const service = row[iSvc] || '';
      const email = row[iEmail] || '';
      if (isOTA(service)) { otaSkip++; continue; }
      const spaceId = mapSpace(staff);
      if (!spaceId) { offScope++; continue; }
      const dt = parseDateTime(row[iDate]);
      if (!dt) { warnings.push(`日時解析不可: id=${row[iId]} "${row[iDate]}"`); continue; }
      const dur = Number(row[iDur] || 0) || 0;
      const { end, crossesDay } = addMinutes(dt.date, dt.start, dur);
      if (crossesDay) warnings.push(`日跨ぎ: id=${row[iId]} ${spaceId} ${dt.date} ${dt.start}+${dur}分`);
      const cat = categorize(email, service);
      const key = `${spaceId}|${dt.date}|${dt.start}`;
      const at = (i) => (i >= 0 ? (row[i] || '').trim() : '');
      const csvEvent = at(iEvent);
      const headStr = at(iHead);
      const slot = {
        booklyKey: key,
        spaceId,
        date: dt.date,
        startTime: dt.start,
        endTime: end,
        durationMin: dur,
        category: cat,
        label: makeLabel(cat, row[iName], service),
        booklyId: row[iId].trim(),
        booklyStaff: staff,
        // サイネージ用の詳細（案X）: イベント名が空なら見出しラベルを使う
        eventName: csvEvent || makeLabel(cat, row[iName], service),
        purpose: at(iPurpose) || null,
        headcount: headStr && /^\d+$/.test(headStr) ? Number(headStr) : null,
        options: parseOptions(service),
        customerName: at(iName) === 'N/A' ? '' : at(iName),
        email: at(iEmail),
        phone: at(iPhone),
        amount: parseAmount(at(iPay), at(iPrice)),
        repeatCustomer: at(iRepeat) === '利用経験あり',
      };
      const prev = bySlot.get(key);
      if (!prev) { bySlot.set(key, slot); continue; }
      // 重複: 顧客 > ブロック > ミラー の優先度でラベル/カテゴリを採用
      const rank = { customer: 3, customer_ticket: 3, block: 2, mirror: 1 };
      if ((rank[cat] || 0) > (rank[prev.category] || 0)) bySlot.set(key, slot);
    }
  }

  const slots = [...bySlot.values()].sort((a, b) =>
    a.date === b.date ? (a.startTime < b.startTime ? -1 : 1) : (a.date < b.date ? -1 : 1),
  );

  // 集計サマリ
  const perSpace = {};
  const perCat = {};
  for (const s of slots) {
    perSpace[s.spaceId] = (perSpace[s.spaceId] || 0) + 1;
    perCat[s.category] = (perCat[s.category] || 0) + 1;
  }
  const meta = {
    generatedAt: new Date().toISOString(),
    sourceFiles: files,
    rawRows: raw,
    otaSkipped: otaSkip,
    offScopeSkipped: offScope,
    slotCount: slots.length,
    dateRange: slots.length ? [slots[0].date, slots[slots.length - 1].date] : [],
    perSpace,
    perCategory: perCat,
    warnings,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ meta, slots }, null, 2));
  console.error(JSON.stringify(meta, null, 2));
  console.error(`\n✔ ${slots.length} slots → ${outPath}`);
}

main();
