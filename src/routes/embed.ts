/**
 * 施設単位の月間カレンダー埋め込み（#19）。
 * 外部サイト（例: meiekifree.space-albe.com / albe-hall.com）に iframe で貼り、
 * その施設だけの空き（○△✕）を月グリッドで表示する。日付クリックで予約画面
 * （booking.space-albe.com/?space=…&date=…）を新規タブで開く（決済/ログインは本体側で安定動作）。
 *
 * データは既存の公開API GET /api/spaces/:id/slots?month=YYYY-MM を利用（同一オリジン）。
 * 施設の解決だけサーバー側で行い（slug/id どちらも可）、id をページへ渡す。
 * 親ウィンドウへ高さを postMessage（{albeCalHeight}）し、ローダー(calendar-embed.js)で自動リサイズ。
 */
import type { Context } from 'hono';
import type { AppBindings } from '../types';
import { getSpaceBySlugOrId } from '../db/repository';
import { todayJST } from '../lib/clock';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function shell(title: string, body: string): string {
  // 予約本体（public/index.html + tokens.css）のカレンダーと同じ見た目に揃える。
  // 丸ピル型マーク（色リング＋淡い塗り）・週末の地色・枠付きパネル・凡例。
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{
    --ink:#1a1917; --ink-2:#6f6c66; --ink-3:#a8a49c;
    --paper:#ffffff; --wash:#f8f7f5; --line:#eae8e3; --line-2:#d8d5ce;
    --key:#0068b7; --key-d:#005694; --key-w:#eef5fb;
    --ok:#0f7b3f; --ok-w:#eaf6ef; --few:#9a5b00; --few-w:#fdf4e3;
    --full:#c02a1e; --full-w:#fdeceb; --closed:#6f6c66; --closed-w:#f1f0ee;
    --sun:#c02a1e; --sat:#0068b7; --holiday-w:#fcfaf4;
    --r-lg:12px; --r-pill:999px;
    --f-num: ui-monospace,"SF Mono","Roboto Mono",Menlo,monospace;
  }
  *{ box-sizing:border-box; }
  html,body{ margin:0; }
  body{ font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",Meiryo,sans-serif; color:var(--ink); background:transparent; padding:8px; }
  .cal{ max-width:560px; margin:0 auto; }
  .calhead{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin:0 2px 8px; }
  .calhead .nm{ font-size:15px; font-weight:700; }
  .calpanel{ border:1px solid var(--line-2); border-radius:var(--r-lg); overflow:hidden; background:var(--paper); }
  .calm{ display:flex; align-items:center; justify-content:space-between; gap:8px;
         padding:8px 10px; background:var(--key-w); border-bottom:1px solid var(--line);
         font-family:var(--f-num); font-size:15px; font-weight:600; }
  .nav{ display:flex; align-items:center; gap:6px; }
  .nav button{ appearance:none; border:1px solid var(--line-2); background:var(--paper); color:var(--ink); width:30px; height:30px; border-radius:8px; font-size:16px; cursor:pointer; line-height:1; }
  .nav button:disabled{ opacity:.35; cursor:default; }
  .caldow{ display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); background:var(--wash); border-bottom:1px solid var(--line); }
  .caldow .dow{ padding:6px 0; text-align:center; font-size:11px; color:var(--ink-2); }
  .caldow .dow:first-child{ color:var(--sun); }
  .caldow .dow:last-child{ color:var(--sat); }
  .calgrid{ display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:1px; background:var(--line); }
  .d{ background:var(--paper); min-height:56px; padding:5px 3px 6px; display:flex; flex-direction:column; align-items:center; gap:2px; text-align:center; }
  .d.out{ background:var(--wash); }
  .d .n{ font-family:var(--f-num); font-size:12px; color:var(--ink-2); line-height:1.1; }
  .d.we{ background:var(--holiday-w); }
  .d.sun .n{ color:var(--sun); }
  .d.sat .n{ color:var(--sat); }
  .d.na .n{ color:var(--ink-3); }
  .mk{ display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; border-radius:var(--r-pill); font-size:13px; font-weight:600; line-height:1; }
  .ok .mk{ background:var(--ok-w); color:var(--ok); box-shadow:inset 0 0 0 1.5px var(--ok); }
  .few .mk{ background:var(--few-w); color:var(--few); box-shadow:inset 0 0 0 1.5px var(--few); }
  .full .mk{ background:var(--full-w); color:var(--full); box-shadow:inset 0 0 0 1.5px var(--full); }
  .closed .mk{ background:var(--closed-w); color:var(--closed); box-shadow:inset 0 0 0 1.5px var(--line-2); }
  .d.clickable{ cursor:pointer; }
  .d.clickable:hover{ background:var(--key-w); }
  .callegend{ display:flex; flex-wrap:wrap; gap:6px 14px; padding:12px 2px 0; font-size:11px; color:var(--ink-2); }
  .callegend span{ display:inline-flex; align-items:center; gap:5px; }
  .callegend i{ width:15px; height:15px; border-radius:var(--r-pill); display:inline-flex; align-items:center; justify-content:center; font-size:9px; font-weight:700; font-style:normal; }
  .l-ok{ background:var(--ok-w); color:var(--ok); box-shadow:inset 0 0 0 1.5px var(--ok); }
  .l-few{ background:var(--few-w); color:var(--few); box-shadow:inset 0 0 0 1.5px var(--few); }
  .l-full{ background:var(--full-w); color:var(--full); box-shadow:inset 0 0 0 1.5px var(--full); }
  .l-closed{ background:var(--closed-w); color:var(--closed); box-shadow:inset 0 0 0 1.5px var(--line-2); }
  @media (min-width:641px){ .d{ min-height:66px; } .mk{ width:26px; height:26px; font-size:14px; } }
  .cta{ margin-top:12px; text-align:center; }
  .cta a{ display:inline-block; background:var(--key); color:#fff; text-decoration:none; font-weight:700; padding:9px 18px; border-radius:8px; font-size:14px; }
  .cta a:hover{ background:var(--key-d); }
  .msg{ font-size:13px; color:var(--ink-2); padding:16px 2px; text-align:center; }
  .err{ font-size:14px; color:var(--full); padding:12px; }
</style></head><body>${body}</body></html>`;
}

export async function embedCalendar(c: Context<AppBindings>): Promise<Response> {
  const key = (c.req.query('space') || '').trim();
  const monthQ = (c.req.query('month') || '').trim();
  const origin = new URL(c.req.url).origin;

  const errPage = (m: string) => c.html(shell('空き状況カレンダー', `<div class="err">${esc(m)}</div>`), 400);
  if (!key) return errPage('スペースが指定されていません（?space=スラッグ）。');

  const space = await getSpaceBySlugOrId(c.env.DB, key);
  if (!space || !space.is_active) {
    return c.html(shell('空き状況カレンダー', `<div class="err">対象のスペースが見つかりませんでした。</div>`), 404);
  }

  const spaceId = space.id;
  const slug = space.slug || space.id;
  const name = space.name;
  const month = /^\d{4}-\d{2}$/.test(monthQ) ? monthQ : todayJST().slice(0, 7);

  const thisMonth = todayJST().slice(0, 7);
  const cfg = JSON.stringify({ id: spaceId, slug, name, base: origin, month, thisMonth });

  const body = `<div class="cal">
  <div class="calhead"><div class="nm">${esc(name)}</div></div>
  <div class="calpanel">
    <div class="calm"><span class="ym" id="ym"></span>
      <span class="nav"><button id="prev" aria-label="前の月">‹</button><button id="next" aria-label="次の月">›</button></span>
    </div>
    <div class="caldow"><div class="dow">日</div><div class="dow">月</div><div class="dow">火</div><div class="dow">水</div><div class="dow">木</div><div class="dow">金</div><div class="dow">土</div></div>
    <div id="grid"><div class="msg">読み込み中…</div></div>
  </div>
  <div class="callegend"><span><i class="l-ok">○</i>空きあり</span><span><i class="l-few">△</i>商談中</span><span><i class="l-full">✕</i>満室</span><span><i class="l-closed">−</i>休業</span></div>
  <div class="cta"><a id="book" href="#" target="_blank" rel="noopener">予約・詳細を見る</a></div>
</div>
<script>
(function(){
  var CFG = ${cfg};
  var elGrid = document.getElementById('grid');
  var elYm = document.getElementById('ym');
  var elPrev = document.getElementById('prev');
  var elNext = document.getElementById('next');
  var book = document.getElementById('book');
  book.href = CFG.base + '/?space=' + encodeURIComponent(CFG.slug);
  var curMonth = CFG.month; // 'YYYY-MM'
  var thisMonth = CFG.thisMonth; // サーバー（JST）基準の当月。過去月への遷移抑止に使用

  function prevMonth(m){ var y=+m.slice(0,4), mo=+m.slice(5,7)-1; mo--; if(mo<0){mo=11;y--;} return y+'-'+String(mo+1).padStart(2,'0'); }
  function nextMonth(m){ var y=+m.slice(0,4), mo=+m.slice(5,7)-1; mo++; if(mo>11){mo=0;y++;} return y+'-'+String(mo+1).padStart(2,'0'); }

  function reportHeight(){
    try{ var h = document.documentElement.scrollHeight; parent.postMessage({ albeCalHeight: h }, '*'); }catch(e){}
  }

  function render(month, resp){
    elYm.textContent = month.slice(0,4) + '年' + (+month.slice(5,7)) + '月';
    elPrev.disabled = (month <= thisMonth); // 過去月へは戻さない
    var days = (resp && resp.days) || [];
    var byDate = {}; days.forEach(function(d){ byDate[d.date] = d; });
    var y = +month.slice(0,4), mo = +month.slice(5,7);
    var startWd = new Date(Date.UTC(y, mo-1, 1)).getUTCDay();
    var daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    var html = '<div class="calgrid">';
    for(var i=0;i<startWd;i++){ html += '<div class="d out"></div>'; }
    for(var dnum=1; dnum<=daysInMonth; dnum++){
      var ymd = month + '-' + String(dnum).padStart(2,'0');
      var wd = new Date(Date.UTC(y, mo-1, dnum)).getUTCDay();
      var info = byDate[ymd];
      var cls = ['d'];
      if(wd===0){ cls.push('sun'); } else if(wd===6){ cls.push('sat'); }
      // 週末・祝日はセルに地色（本体カレンダーと同じ）
      if(info && info.dayType==='weekend'){ cls.push('we'); }
      var mk = '', clickable = false;
      if(info){
        if(info.past){ cls.push('na'); } // 過去日：マークなし・淡色
        else{
          mk = info.symbol || '';
          if(info.status==='available'){ cls.push('ok'); }
          else if(info.status==='limited'){ cls.push('few'); }
          else if(info.status==='full'){ cls.push('full'); }
          else if(info.status==='closed'){ cls.push('closed'); }
          // 予約可能・商談中・閲覧可はクリックで予約画面へ誘導（施設設定は本体側で判定）
          if(!info.closed){ clickable = true; cls.push('clickable'); }
        }
      } else {
        cls.push('na');
      }
      var attr = clickable ? (' data-d="'+ymd+'"') : '';
      var mkHtml = mk ? ('<span class="mk">'+mk+'</span>') : '';
      html += '<div class="'+cls.join(' ')+'"'+attr+'><span class="n">'+dnum+'</span>'+mkHtml+'</div>';
    }
    var tail = (startWd + daysInMonth) % 7;
    if(tail){ for(var t=tail;t<7;t++){ html += '<div class="d out"></div>'; } }
    html += '</div>';
    elGrid.innerHTML = html;
    // 日付クリック→予約画面を新規タブで開く
    elGrid.querySelectorAll('.d[data-d]').forEach(function(cell){
      cell.addEventListener('click', function(){
        var d = cell.getAttribute('data-d');
        window.open(CFG.base + '/?space=' + encodeURIComponent(CFG.slug) + '&date=' + d, '_blank', 'noopener');
      });
    });
    setTimeout(reportHeight, 30);
  }

  function load(month){
    curMonth = month;
    elGrid.innerHTML = '<div class="msg">読み込み中…</div>';
    fetch(CFG.base + '/api/spaces/' + encodeURIComponent(CFG.id) + '/slots?month=' + month, { credentials:'omit' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(body){
        if(!body){ elGrid.innerHTML = '<div class="msg">空き状況を取得できませんでした。しばらくして再度お試しください。</div>'; setTimeout(reportHeight,30); return; }
        render(month, body);
      })
      .catch(function(){ elGrid.innerHTML = '<div class="msg">通信エラーが発生しました。</div>'; setTimeout(reportHeight,30); });
  }

  elPrev.addEventListener('click', function(){ if(elPrev.disabled) return; load(prevMonth(curMonth)); });
  elNext.addEventListener('click', function(){ load(nextMonth(curMonth)); });
  window.addEventListener('resize', reportHeight);
  load(curMonth);
})();
</script>`;

  return c.html(shell(name + ' 空き状況カレンダー', body), 200, {
    'Cache-Control': 'public, max-age=120',
  });
}
