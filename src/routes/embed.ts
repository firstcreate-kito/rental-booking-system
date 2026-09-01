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
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{ --ink:#1a1917; --ink-2:#6f6c66; --ink-3:#a8a49c; --line:#e7e5e0; --wash:#f7f6f4; --ok:#1f7a3d; --talk:#b26a00; --full:#b0392f; --brand:#1f6feb; }
  *{ box-sizing:border-box; }
  html,body{ margin:0; }
  body{ font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif; color:var(--ink); background:transparent; padding:8px; }
  .cal{ max-width:560px; margin:0 auto; }
  .hd{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
  .hd .nm{ font-size:15px; font-weight:700; }
  .nav{ display:flex; align-items:center; gap:6px; }
  .nav button{ appearance:none; border:1px solid var(--line); background:#fff; color:var(--ink); width:32px; height:32px; border-radius:8px; font-size:16px; cursor:pointer; line-height:1; }
  .nav button:disabled{ opacity:.35; cursor:default; }
  .ym{ font-size:14px; font-weight:600; min-width:104px; text-align:center; font-variant-numeric:tabular-nums; }
  table{ width:100%; border-collapse:collapse; table-layout:fixed; }
  th{ font-size:11px; color:var(--ink-2); font-weight:600; padding:4px 0; }
  th.sun{ color:var(--full); } th.sat{ color:var(--brand); }
  td{ height:52px; border:1px solid var(--line); vertical-align:top; padding:3px 4px; background:#fff; }
  td.empty{ background:var(--wash); border-color:var(--wash); }
  td .d{ font-size:12px; color:var(--ink-2); font-variant-numeric:tabular-nums; }
  td.sun .d{ color:var(--full); } td.sat .d{ color:var(--brand); }
  td .s{ display:block; text-align:center; font-size:18px; line-height:1.1; margin-top:2px; }
  td.ok .s{ color:var(--ok); } td.talk .s{ color:var(--talk); } td.full .s{ color:var(--full); } td.closed .s{ color:var(--ink-3); }
  td.click{ cursor:pointer; }
  td.click:hover{ background:#eef4ff; }
  td.past{ background:var(--wash); }
  td.past .d, td.past .s{ color:var(--ink-3); }
  .legend{ display:flex; flex-wrap:wrap; gap:12px; margin:8px 2px 0; font-size:12px; color:var(--ink-2); }
  .legend b{ font-weight:700; }
  .legend .ok{ color:var(--ok); } .legend .talk{ color:var(--talk); } .legend .full{ color:var(--full); }
  .cta{ margin-top:10px; text-align:center; }
  .cta a{ display:inline-block; background:var(--brand); color:#fff; text-decoration:none; font-weight:700; padding:9px 18px; border-radius:8px; font-size:14px; }
  .msg{ font-size:13px; color:var(--ink-2); padding:8px 2px; }
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
  <div class="hd">
    <div class="nm">${esc(name)}</div>
    <div class="nav"><button id="prev" aria-label="前の月">‹</button><span class="ym" id="ym"></span><button id="next" aria-label="次の月">›</button></div>
  </div>
  <div id="grid"><div class="msg">読み込み中…</div></div>
  <div class="legend"><span><b class="ok">○</b> 空きあり</span><span><b class="talk">△</b> 商談中</span><span><b class="full">✕</b> 満室</span><span><b>−</b> 休業</span></div>
  <div class="cta"><a id="book" href="#" target="_blank" rel="noopener">予約・詳細を見る</a></div>
</div>
<script>
(function(){
  var CFG = ${cfg};
  var WD = ['日','月','火','水','木','金','土'];
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
    var first = new Date(month + '-01T00:00:00');
    var startWd = first.getUTCDay();
    var y = +month.slice(0,4), mo = +month.slice(5,7);
    var daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    var html = '<table><thead><tr>';
    for(var w=0; w<7; w++){ html += '<th class="'+(w===0?'sun':(w===6?'sat':''))+'">'+WD[w]+'</th>'; }
    html += '</tr></thead><tbody><tr>';
    for(var i=0;i<startWd;i++){ html += '<td class="empty"></td>'; }
    var col = startWd;
    for(var dnum=1; dnum<=daysInMonth; dnum++){
      var ymd = month + '-' + String(dnum).padStart(2,'0');
      var wd = new Date(ymd + 'T00:00:00Z').getUTCDay();
      var info = byDate[ymd];
      var cls = [(wd===0?'sun':(wd===6?'sat':''))];
      var sym = '', clickable = false;
      if(info){
        if(info.past){ cls.push('past'); sym = ''; }
        else{
          sym = info.symbol || '';
          if(info.status==='available'){ cls.push('ok'); }
          else if(info.status==='limited'){ cls.push('talk'); }
          else if(info.status==='full'){ cls.push('full'); }
          else if(info.status==='closed'){ cls.push('closed'); }
          // 予約可能・商談中・閲覧可（viewOnly）はクリックで予約画面へ誘導（施設設定は本体側で判定）
          if(!info.closed && !info.past){ clickable = true; cls.push('click'); }
        }
      }
      var attr = clickable ? (' data-d="'+ymd+'"') : '';
      html += '<td class="'+cls.join(' ')+'"'+attr+'><span class="d">'+dnum+'</span><span class="s">'+sym+'</span></td>';
      col++;
      if(col===7 && dnum!==daysInMonth){ html += '</tr><tr>'; col=0; }
    }
    while(col>0 && col<7){ html += '<td class="empty"></td>'; col++; }
    html += '</tr></tbody></table>';
    elGrid.innerHTML = html;
    // 日付クリック→予約画面を新規タブで開く
    elGrid.querySelectorAll('td[data-d]').forEach(function(td){
      td.addEventListener('click', function(){
        var d = td.getAttribute('data-d');
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
