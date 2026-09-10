import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { getAllSpaces, getSpaceBySlugOrId, getSignageBookings } from '../db/repository';
import { todayJST, nowJST } from '../lib/clock';
import { buildSignageItems } from '../lib/signage-display';

/**
 * サイネージ（モニター常設）表示ページ（#124）。
 * - 予約データと直結。ブラウザ/モニターで全画面表示。横幅100%。
 * - できるだけリアルタイム：クライアントが data.json を短間隔でポーリング＋時計は毎秒更新。
 * - 表示名：イベント名があれば優先、無ければ「姓 様」。時刻は「10:00～11:00」。
 * - 公開表示（トークン不要）。出す個人情報は最小限（姓＋様のみ・下の名前や連絡先は出さない）。
 * ルート：
 *   GET /signage/room/list        … 稼働スペース一覧（各部屋へのリンク）
 *   GET /signage/room/:key        … 個別スペースの全画面表示（key = slug または id）
 *   GET /signage/room/:key/data.json … 表示用データ（公開JSON）
 */
const app = new Hono<AppBindings>();

const POLL_MS = 20000; // 表示データの再取得間隔（ミリ秒）

function esc(x: unknown): string {
  return String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%}
body{background:#0b1020;color:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Hiragino Sans','Noto Sans JP',Meiryo,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
`;

/** 一覧ページ */
app.get('/room/list', async (c) => {
  const spaces = (await getAllSpaces(c.env.DB)).filter((s) => s.is_active);
  const cards = spaces
    .map((s) => {
      const key = s.slug || s.id;
      return `<a class="card" href="/signage/room/${encodeURIComponent(key)}"><div class="nm">${esc(s.name)}</div><div class="go">サイネージを開く →</div></a>`;
    })
    .join('');
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>サイネージ｜スペース一覧</title><style>${BASE_CSS}
.wrap{min-height:100%;padding:clamp(16px,4vw,48px)}
h1{font-size:clamp(20px,3vw,32px);margin-bottom:.6em;font-weight:800;letter-spacing:.02em}
.muted{color:#9fb0c9;font-size:clamp(12px,1.4vw,15px);margin-bottom:1.4em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:clamp(12px,2vw,20px)}
.card{display:flex;flex-direction:column;justify-content:space-between;gap:.8em;background:#141c33;border:1px solid #26304d;border-radius:16px;padding:clamp(16px,2.4vw,28px);min-height:120px;transition:transform .1s,border-color .1s}
.card:hover{transform:translateY(-2px);border-color:#4a76ff}
.nm{font-size:clamp(18px,2.2vw,26px);font-weight:800}
.go{color:#8fb0ff;font-size:clamp(12px,1.4vw,15px)}
</style></head><body><div class="wrap"><h1>レンタルスペースALBE｜サイネージ</h1><div class="muted">表示したいスペースを選んでください。モニターにはこのURLを開いて全画面表示（F11）してください。</div><div class="grid">${cards || '<div class="muted">表示できるスペースがありません。</div>'}</div></div></body></html>`;
  return c.html(html);
});

/** 表示用データ（公開JSON） */
app.get('/room/:key/data.json', async (c) => {
  const key = c.req.param('key');
  const space = await getSpaceBySlugOrId(c.env.DB, key);
  if (!space || !space.is_active) return c.json({ error: 'not found' }, 404);
  const date = todayJST();
  const now = nowJST().slice(11, 16);
  const rows = await getSignageBookings(c.env.DB, space.id, date);
  const items = buildSignageItems(rows, now);
  const totalToday = rows.length;
  let message: string | null = null;
  if (totalToday === 0) message = '本日の予約はありません';
  else if (items.length === 0) message = '本日の予約は全て終了しました';
  // モニター常設のためキャッシュさせない
  c.header('Cache-Control', 'no-store');
  return c.json({ spaceName: space.name, date, now, items, message });
});

/** 個別スペースの全画面サイネージ */
app.get('/room/:key', async (c) => {
  const key = c.req.param('key');
  const space = await getSpaceBySlugOrId(c.env.DB, key);
  if (!space || !space.is_active) {
    return c.html('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">指定のスペースが見つかりませんでした。<br><a href="/signage/room/list">一覧へ戻る</a></body>', 404);
  }
  const dataUrl = `/signage/room/${encodeURIComponent(key)}/data.json`;
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(space.name)}｜サイネージ</title><style>${BASE_CSS}
.screen{display:flex;flex-direction:column;height:100vh;width:100vw;padding:clamp(16px,3vw,40px);gap:clamp(12px,2vh,24px)}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:16px;border-bottom:2px solid #26304d;padding-bottom:clamp(8px,1.4vh,16px)}
.sname{font-size:clamp(24px,4.5vw,64px);font-weight:900;letter-spacing:.02em;line-height:1.05}
.clock{text-align:right;white-space:nowrap}
.clock .t{font-size:clamp(28px,5vw,72px);font-weight:800;font-variant-numeric:tabular-nums;line-height:1}
.clock .d{font-size:clamp(12px,1.6vw,22px);color:#9fb0c9;margin-top:.2em}
.body{flex:1;display:flex;flex-direction:column;gap:clamp(10px,1.6vh,20px);overflow:hidden}
.sec-label{font-size:clamp(13px,1.6vw,20px);color:#8fb0ff;font-weight:700;letter-spacing:.08em}
.now-card{background:linear-gradient(135deg,#12336b,#1b4bd0);border-radius:18px;padding:clamp(16px,2.6vh,34px);display:flex;justify-content:space-between;align-items:center;gap:16px;box-shadow:0 6px 30px rgba(30,80,220,.25)}
.now-card .label{font-size:clamp(26px,4.5vw,60px);font-weight:900;line-height:1.1;word-break:break-word}
.now-card .time{font-size:clamp(22px,3.4vw,44px);font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}
.badge{display:inline-block;background:#ff5470;color:#fff;font-size:clamp(11px,1.3vw,16px);font-weight:800;border-radius:999px;padding:.2em .8em;margin-bottom:.4em;letter-spacing:.06em}
.list{display:flex;flex-direction:column;gap:clamp(8px,1.2vh,14px);overflow:auto}
.row{display:flex;justify-content:space-between;align-items:center;gap:16px;background:#141c33;border:1px solid #26304d;border-radius:14px;padding:clamp(12px,1.8vh,22px) clamp(14px,2vw,26px)}
.row .label{font-size:clamp(20px,3vw,40px);font-weight:800;word-break:break-word}
.row .time{font-size:clamp(18px,2.4vw,32px);font-weight:700;color:#cfe0ff;font-variant-numeric:tabular-nums;white-space:nowrap}
.empty{flex:1;display:flex;align-items:center;justify-content:center;color:#9fb0c9;font-size:clamp(20px,3vw,40px);font-weight:700;text-align:center}
.foot{color:#5f6f8c;font-size:clamp(10px,1.1vw,13px);text-align:center}
.stale{opacity:.55}
</style></head><body>
<div class="screen">
  <div class="top">
    <div class="sname" id="sname">${esc(space.name)}</div>
    <div class="clock"><div class="t" id="clock">--:--</div><div class="d" id="date"></div></div>
  </div>
  <div class="body" id="body"><div class="empty">読み込み中…</div></div>
  <div class="foot" id="foot">レンタルスペースALBE</div>
</div>
<script>
(function(){
  var DATA_URL=${JSON.stringify(dataUrl)};
  var POLL=${POLL_MS};
  var state={items:[],message:null,ok:false};
  var lastOk=0;
  function pad(n){return (n<10?'0':'')+n;}
  function nowHHMM(){var d=new Date();return pad(d.getHours())+':'+pad(d.getMinutes());}
  var WD=['日','月','火','水','木','金','土'];
  function tickClock(){
    var d=new Date();
    document.getElementById('clock').textContent=pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
    document.getElementById('date').textContent=(d.getMonth()+1)+'月'+d.getDate()+'日（'+WD[d.getDay()]+'）';
  }
  function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
  function render(){
    var body=document.getElementById('body');
    body.innerHTML='';
    var now=nowHHMM();
    // クライアント側でも状態を再判定（ポーリング間の切り替わりに追従）
    var live=(state.items||[]).filter(function(it){return it.end>now;}).map(function(it){
      return {label:it.label,start:it.start,end:it.end,range:it.range,status:(it.start<=now?'ongoing':'upcoming')};
    });
    var ongoing=live.filter(function(i){return i.status==='ongoing';});
    var upcoming=live.filter(function(i){return i.status==='upcoming';});
    if(live.length===0){
      var em=el('div','empty',state.message||'本日の予約はありません');
      body.appendChild(em);
    } else {
      if(ongoing.length){
        body.appendChild(el('div','sec-label','ただいまご利用中'));
        ongoing.forEach(function(i){
          var card=el('div','now-card');
          var left=el('div');
          left.appendChild(el('div','badge','利用中'));
          left.appendChild(el('div','label',i.label));
          card.appendChild(left);
          card.appendChild(el('div','time',i.range));
          body.appendChild(card);
        });
      }
      if(upcoming.length){
        body.appendChild(el('div','sec-label','本日のご予約'));
        var list=el('div','list');
        upcoming.forEach(function(i){
          var row=el('div','row');
          row.appendChild(el('div','label',i.label));
          row.appendChild(el('div','time',i.range));
          list.appendChild(row);
        });
        body.appendChild(list);
      }
    }
    // 取得が古い場合は薄く表示（通信断の視覚フィードバック）
    var stale=state.ok && (Date.now()-lastOk>POLL*3);
    document.body.classList.toggle('stale',!!stale);
  }
  function fetchData(){
    fetch(DATA_URL,{cache:'no-store'}).then(function(r){return r.ok?r.json():Promise.reject();}).then(function(j){
      state.items=j.items||[];state.message=j.message||null;state.ok=true;lastOk=Date.now();
      if(j.spaceName)document.getElementById('sname').textContent=j.spaceName;
      render();
    }).catch(function(){ /* 失敗時は前回表示を維持 */ render(); });
  }
  tickClock();setInterval(tickClock,1000);
  fetchData();setInterval(fetchData,POLL);
  // 毎秒 render して、ちょうどの時刻で「利用中/予約」が切り替わるようにする
  setInterval(render,1000);
})();
</script>
</body></html>`;
  c.header('Cache-Control', 'no-store');
  return c.html(html);
});

export default app;
