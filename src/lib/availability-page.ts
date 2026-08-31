/**
 * 空き状況ページ（/availability/）のサーバーサイド描画（#74）。
 * Worker が D1 を引いて組み立てた AvailabilityResult を、完全なHTMLにして返す。
 * ※デザインは暫定。トークン(:root)＋共通部品(ヘッダー/フッター/パンくず)を基盤に、後で差し替え可能。
 */
import type { AvailabilityResult, AvailabilityRow } from './availability-service';
import { escapeHtml } from './email';

export interface PageContext {
  today: string;
  tomorrow: string;
  weekend: string;
  contactUrl: string;
  lineUrl: string;
  loginUrl: string;
  /** WEBサイト等へ iframe 埋め込みするモード（#19）。ヘッダー等を省き、予約リンクは親窓で開く。 */
  embed?: boolean;
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];
function labelYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${m}月${d}日（${WD[wd]}）`;
}
const yen = (n: number) => n.toLocaleString('ja-JP');

function chipHref(base: { date: string; use: string; area: string }, patch: Partial<{ date: string; use: string; area: string }>, embed?: boolean): string {
  const p = { ...base, ...patch };
  const q = new URLSearchParams();
  q.set('date', p.date);
  if (p.use && p.use !== 'all') q.set('use', p.use);
  if (p.area && p.area !== 'all') q.set('area', p.area);
  if (embed) q.set('embed', '1'); // 埋め込み内の日付/絞り込み遷移でも埋め込みモードを維持
  return `/availability/?${q.toString()}`;
}

function windowsText(r: AvailabilityRow): string {
  if (!r.freeWindows.length) return '';
  return r.freeWindows.map((w) => `${w.start}〜${w.end}`).join(' / ') + ' 空き';
}

function rowHtml(r: AvailabilityRow, ctx: PageContext): string {
  const rooms = r.roomsTotal > 1 ? ` <span class="rooms">空き${r.roomsFree}室／${r.roomsTotal}室</span>` : '';
  const priceHtml = r.price != null ? `${yen(r.price)}<u>${r.priceUnit}</u>` : '<span class="q">要確認</span>';
  let mark = '○';
  let rtime = '';
  if (r.status === 'ok') {
    mark = '○';
    rtime = windowsText(r);
  } else if (r.status === 'talk') {
    mark = '△';
    rtime = '商談中 ─ ご相談は承ります';
  } else if (r.status === 'sameday') {
    mark = '×';
    rtime = '当日のご予約は承っておりません';
  } else {
    mark = r.closed ? '−' : '×';
    rtime = r.closed ? '休業' : '満室';
  }
  const next = r.status !== 'ok' && r.nextOpen ? `<div class="next">次に空いているのは <b>${labelYmd(r.nextOpen)}</b></div>` : '';
  // 予約可能期間より先＝閲覧のみ（ネット予約対象外）。まずカレンダーへ誘導する（#77）
  const viewNote = r.viewOnly ? `<div class="next">この期間はネット予約対象外 ─ 長期・複数日はカレンダーからお問い合わせください</div>` : '';
  // どの状態でも「まず施設カレンダー（選んだ日の月）」へ遷移させる。指定日が満室・商談中・
  // お問い合わせのみでも、前後の日の空きを見て検討できるようにするため。カレンダー側で
  //  ・予約可能な日 → その日の時刻選択モーダルを自動で開く
  //  ・満室/閲覧のみ/商談中/お問い合わせのみ → モーダルは開かず、日付クリックで施設設定に応じた案内
  // を出す（openModal/施設設定ガードで制御）。
  const href = r.spaceHref;
  const meta = [r.areaName, r.meta].filter(Boolean).join('・');
  // サムネイル（左端）。http(s)/相対パスのみ許可。未設定・不正URLはプレースホルダの箱を表示。
  const safeImg = r.imageUrl && /^(https?:\/\/|\/)/i.test(r.imageUrl) ? r.imageUrl : null;
  const thumb = safeImg
    ? `<img class="rthumb" src="${escapeHtml(safeImg)}" alt="${escapeHtml(r.name)}" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`
    : `<span class="rthumb ph" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5-5-8 8"/></svg></span>`;
  const body =
    `<div><div class="rname">${escapeHtml(r.name)}${rooms}</div>` +
    `<div class="rmeta">${escapeHtml(meta)}</div></div>` +
    `<div class="rprice">${priceHtml}</div>` +
    `<div class="rstat"><span class="mark">${mark}</span><span class="rtime">${escapeHtml(rtime)}</span></div>` +
    next + viewNote;
  const inner = `${thumb}<div class="rbody">${body}</div>`;
  // 埋め込み時は予約/相談リンクを親ウィンドウで開く（iframe内だと決済・ログインが壊れるため）
  const tgt = ctx.embed ? ' target="_top"' : '';
  return href ? `<a class="row"${tgt} href="${escapeHtml(href)}">${inner}</a>` : `<div class="row">${inner}</div>`;
}

function groupHtml(title: string, rows: AvailabilityRow[], ctx: PageContext): string {
  if (!rows.length) return '';
  return `<div class="ghead">${escapeHtml(title)}（${rows.length}）</div>` + rows.map((r) => rowHtml(r, ctx)).join('');
}

export function renderAvailabilityPage(data: AvailabilityResult, ctx: PageContext): string {
  const embed = !!ctx.embed;
  const base = { date: data.date, use: data.filters.use, area: data.filters.area };
  const uses = [
    ['all', 'すべて'],
    ['piano', 'ピアノ・防音室'],
    ['photo', '撮影'],
    ['event', 'イベント'],
    ['storage', '保管・倉庫'],
  ];
  const areas = [
    ['all', 'すべて'],
    ['meieki', '名古屋駅'],
    ['sakae', '栄'],
    ['naka', '中区'],
    ['chikusa', '千種区'],
    ['other', 'その他'],
  ];
  const dchip = (label: string, date: string) =>
    `<a class="dchip${date === data.date ? ' on' : ''}" href="${chipHref(base, { date }, embed)}">${label}</a>`;
  const chipRow = (id: string, items: string[][], current: string) =>
    items
      .map(([v, l]) => `<a class="chip${v === current ? ' on' : ''}" href="${chipHref(base, { [id]: v }, embed)}">${escapeHtml(l)}</a>`)
      .join('');

  const lastSync = data.lastSyncAt ? data.lastSyncAt.slice(11, 16) : null;
  const samedaySection = data.isToday ? groupHtml('当日のご予約を承っておりません', data.groups.sameday, ctx) : '';

  const listHtml =
    groupHtml('空きあり', data.groups.ok, ctx) +
    groupHtml('商談中 ─ ご相談は承ります', data.groups.talk, ctx) +
    samedaySection +
    groupHtml('満室', data.groups.full, ctx);

  const title = '空き状況をカレンダーで確認｜名古屋のレンタルスペースALBE';
  const desc = '名古屋のレンタルスペースALBE 19施設の空き状況を日付から確認できます。ピアノ練習室、撮影スタジオ、イベントスペース、倉庫。当日予約も可能です。';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<link rel="canonical" href="https://space-albe.com/availability/">
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/albe-header.css">
${embed ? '' : `<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0068b7">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="ALBE予約">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="icon" href="/assets/icon-192.png" type="image/png">
<script src="/assets/pwa.js" defer></script>
<script src="/assets/analytics.js" defer></script>`}
<style>
:root{ --ink:#1a1917; --ink-2:#6f6c66; --ink-3:#a8a49c; --paper:#fff; --wash:#f8f7f5; --line:#eae8e3; --line-2:#d8d5ce; --r:2px; --pad:16px; --maxw:1080px;
  --f-sans:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",Meiryo,sans-serif; --f-num:ui-monospace,"SF Mono",Menlo,monospace; }
*{ box-sizing:border-box; } html{ -webkit-text-size-adjust:100%; }
body{ margin:0; background:var(--paper); color:var(--ink); font-family:var(--f-sans); font-size:16px; line-height:1.7; font-feature-settings:"palt" 1; padding-bottom:calc(58px + env(safe-area-inset-bottom)); }
a{ color:inherit; text-decoration:none; }
.wrap{ padding:0 var(--pad); }
.hd{ border-bottom:1px solid var(--line); } .hd-in{ display:flex; align-items:center; justify-content:space-between; height:52px; }
.logo{ font-size:15px; font-weight:600; letter-spacing:.32em; } .login{ font-size:13px; border:1px solid var(--line-2); border-radius:var(--r); min-height:36px; display:flex; align-items:center; padding:0 13px; }
.crumb{ padding:10px var(--pad) 0; font-size:11px; color:var(--ink-3); } .crumb a{ border-bottom:1px solid var(--line-2); }
h1{ margin:14px 0 8px; padding:0 var(--pad); font-size:21px; font-weight:600; } .lede{ margin:0 0 18px; padding:0 var(--pad); font-size:14px; color:var(--ink-2); }
.datebar{ border-top:1px solid var(--line); border-bottom:1px solid var(--line); padding:13px 0; background:var(--wash); }
.dlabel,.flabel{ display:block; font-size:11px; letter-spacing:.14em; color:var(--ink-3); padding:0 var(--pad) 8px; }
.dchips,.chips{ display:flex; flex-wrap:wrap; gap:7px; padding:0 var(--pad); }
.dchip,.chip{ font-size:13px; line-height:1; color:var(--ink-2); background:var(--paper); border:1px solid var(--line-2); border-radius:var(--r); min-height:38px; display:flex; align-items:center; padding:0 14px; }
.chip{ background:transparent; min-height:36px; }
.dchip.on,.chip.on{ background:var(--ink); border-color:var(--ink); color:#fff; }
.dpick{ display:flex; align-items:center; gap:8px; padding:10px var(--pad) 0; } .dpick input{ font-family:var(--f-num); width:auto; } /* 入力欄の基本スタイルは tokens.css（R13-7〜R13-11） */
.frow{ padding:11px 0; border-bottom:1px solid var(--line); }
.headline{ padding:18px var(--pad) 12px; } .headline b{ display:block; font-size:19px; font-weight:600; } .headline span{ font-size:13px; color:var(--ink-2); }
.ghead{ padding:10px var(--pad) 8px; font-size:12px; letter-spacing:.1em; color:var(--ink-3); border-top:1px solid var(--line); background:var(--wash); }
.row{ display:flex; gap:12px; padding:13px var(--pad); border-top:1px solid var(--line); align-items:center; }
.rbody{ flex:1 1 auto; min-width:0; display:grid; grid-template-columns:1fr auto; gap:4px 12px; align-items:center; }
.rthumb{ flex:0 0 auto; width:64px; height:64px; border-radius:6px; object-fit:cover; background:var(--wash); border:1px solid var(--line); }
.rthumb.ph{ display:flex; align-items:center; justify-content:center; color:var(--ink-3); }
.rname{ font-size:15px; font-weight:600; } .rmeta{ font-size:12px; color:var(--ink-2); } .rooms{ font-size:12px; color:var(--ink-2); font-weight:400; }
.rstat{ grid-column:1/-1; display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; margin-top:2px; } .mark{ font-family:var(--f-num); font-size:17px; } .rtime{ font-size:13px; color:var(--ink-2); }
.rprice{ font-family:var(--f-num); font-size:14px; text-align:right; white-space:nowrap; } .rprice u{ text-decoration:none; font-family:var(--f-sans); font-size:11px; color:var(--ink-2); } .rprice .q{ font-family:var(--f-sans); font-size:12px; color:var(--ink-2); }
.next{ grid-column:1/-1; margin-top:6px; font-size:12px; color:var(--ink-2); } .next b{ font-family:var(--f-num); color:var(--ink); }
.legend{ display:flex; flex-wrap:wrap; gap:0 16px; padding:12px var(--pad); border-top:1px solid var(--line); font-size:12px; color:var(--ink-2); } .legend b{ font-family:var(--f-num); color:var(--ink); margin-right:5px; }
.updated{ padding:4px var(--pad) 0; font-size:11px; color:var(--ink-3); }
.help{ margin:20px var(--pad) 0; border:1px solid var(--ink); padding:16px; } .help h2{ margin:0 0 6px; font-size:15px; } .help p{ margin:0 0 14px; font-size:13px; color:var(--ink-2); }
.acts{ display:flex; gap:8px; } .act{ flex:1; text-align:center; min-height:44px; line-height:44px; font-size:14px; font-weight:600; border:1px solid var(--ink); } .act.primary{ background:var(--ink); color:#fff; }
.legalnav{ display:flex; flex-wrap:wrap; gap:0 18px; padding:14px var(--pad) 0; border-top:1px solid var(--line); margin-top:28px; } .legalnav a{ font-size:12px; color:var(--ink-2); min-height:38px; display:flex; align-items:center; }
.ft-note{ padding:6px var(--pad) 28px; font-size:11px; color:var(--ink-3); }
.bar{ position:fixed; left:0; right:0; bottom:0; z-index:20; display:grid; grid-template-columns:1.3fr 1fr 1fr; gap:1px; background:var(--line); border-top:1px solid var(--line); padding-bottom:env(safe-area-inset-bottom); }
.bar a{ min-height:57px; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:600; background:var(--paper); } .bar a.primary{ background:var(--ink); color:#fff; }
@media (min-width:700px){ :root{ --pad:24px; } h1{ font-size:27px; } }
@media (min-width:900px){ body{ padding-bottom:0; } .bar{ display:none; } .hd-in,.crumb,h1,.lede,.datebar>*,.frow>*,.headline,#list,.legend,.updated,.help,.legalnav,.ft-note{ max-width:var(--maxw); margin-left:auto; margin-right:auto; } }
${embed ? 'body{ padding-bottom:0 !important; } .datebar{ border-top:0; }' : ''}
</style>
</head>
<body${embed ? ' class="embed"' : ''}>
${embed ? '' : `<header class="albe-topbar">
  <a class="albe-brand" href="https://space-albe.com/" aria-label="レンタルスペースALBE トップへ">
    <img class="albe-logo" src="/assets/albe-logo.svg" alt="レンタルスペースALBE" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
    <span class="albe-brand-text">RENTAL SPACE ALBE</span>
  </a>
  <nav class="albe-nav">
    <a class="albe-mini" href="${escapeHtml(ctx.loginUrl)}">ログイン</a>
    <a class="albe-contact" href="https://space-albe.com/contact/">お問い合わせ</a>
  </nav>
</header>
<nav class="crumb"><a href="/">ホーム</a> ／ 空き状況</nav>
<h1>空き状況</h1>
<p class="lede">日付を選ぶと、その日に使える施設が一覧で表示されます。当日のご予約も可能です。</p>`}

<section class="datebar" aria-label="日付の選択">
  <span class="dlabel">日付</span>
  <div class="dchips">${dchip('今日', ctx.today)}${dchip('明日', ctx.tomorrow)}${dchip('今週末', ctx.weekend)}</div>
  <div class="dpick"><input type="date" id="dinput" value="${data.date}" aria-label="日付を指定"></div>
</section>

<div class="frow"><span class="flabel">用途</span><div class="chips">${chipRow('use', uses, data.filters.use)}</div></div>
<div class="frow"><span class="flabel">エリア</span><div class="chips">${chipRow('area', areas, data.filters.area)}</div></div>

<main>
  <div class="headline"><b>${escapeHtml(data.weekdayLabel)}</b><span>${data.counts.open}施設に空きがあります（${data.counts.total}施設中）</span></div>
  <div id="list">${listHtml || '<div class="ghead">該当する施設がありません</div>'}</div>
  <div class="legend"><span><b>○</b>空きあり</span><span><b>△</b>商談中（ご相談は承ります）</span><span><b>×</b>満室</span></div>
  ${lastSync ? `<div class="updated">最終更新 ${lastSync}（5分ごとに同期しています）</div>` : ''}
  ${embed ? '' : `<div class="help">
    <h2>お探しの条件が見つからないとき</h2>
    <p>連日のご利用、長期の貸切、商談中の日程のご相談も承ります。お気軽にお問い合わせください。</p>
    <div class="acts"><a class="act primary" href="${escapeHtml(ctx.contactUrl || '/')}">日程を伝えて相談</a><a class="act" href="${escapeHtml(ctx.lineUrl)}">LINEで聞く</a></div>
  </div>`}
</main>

${embed ? '' : `<footer>
  <nav class="legalnav"><a href="/kiyaku/">ご利用規約</a><a href="/tokutei/">特定商取引法に基づく表示</a><a href="/privacy/">プライバシーポリシー</a><a href="/company/">運営会社</a></nav>
  <p class="ft-note">© 株式会社ファーストクリエイト／レンタルスペースALBE</p>
</footer>

<nav class="bar" aria-label="主な操作"><a href="/" class="primary">スペースを探す</a><a href="${escapeHtml(ctx.contactUrl || '/')}">相談</a><a href="${escapeHtml(ctx.lineUrl)}">LINE</a></nav>`}

<script>
// 日付入力の変更で同ページへ遷移（初期表示はSSR済み・これは補助）
var di=document.getElementById('dinput');
if(di){di.addEventListener('change',function(){if(this.value){var u=new URL(location.href);u.searchParams.set('date',this.value);location.href=u.toString();}});}
</script>
${embed ? `<script>
// 埋め込み用：親ウィンドウへ高さを通知し、iframeを自動リサイズさせる
(function(){
  function h(){ return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0); }
  function post(){ try{ parent.postMessage({ albeEmbedHeight: h() }, '*'); }catch(e){} }
  window.addEventListener('load', post);
  window.addEventListener('resize', post);
  if (window.ResizeObserver) { try { new ResizeObserver(post).observe(document.documentElement); } catch(e){} }
  setTimeout(post, 300); setTimeout(post, 1200);
})();
</script>` : ''}
</body>
</html>`;
}
