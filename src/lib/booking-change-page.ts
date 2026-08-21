/**
 * ゲスト予約の確認・変更ページ（/booking-change/）のHTML（#75）。
 * 静的アセットのURL正規化リダイレクトを避けるため、Workerが直接HTMLを返す。
 * ※デザインは暫定。編集は原則このファイルで行う。
 */
export const BOOKING_CHANGE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ご予約の確認・変更｜レンタルスペースALBE</title>
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/albe-header.css">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0068b7">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="ALBE予約">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="icon" href="/assets/icon-192.png" type="image/png">
<script src="/assets/pwa.js" defer></script>
<style>
/* サイト共通の見た目（tokens.css）に対応づけ。中間色・角丸・余白は tokens.css を継承 */
:root{ --brand:var(--key); --bad:var(--full);
  --f:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",Meiryo,sans-serif; }
*{ box-sizing:border-box; } body{ margin:0; background:var(--wash); color:var(--ink); font-family:var(--f-sans); line-height:1.7; }
main{ max-width:560px; margin:0 auto; padding:24px var(--pad) 60px; }
.hd{ background:#fff; border-bottom:1px solid var(--line); }
.hd-in{ max-width:560px; margin:0 auto; height:52px; display:flex; align-items:center; padding:0 var(--pad); }
.logo{ font-weight:600; letter-spacing:.3em; }
h1{ font-size:20px; margin:4px 0 6px; } .lede{ color:var(--ink-2); font-size:14px; margin:0 0 18px; }
.card{ background:#fff; border:1px solid var(--line); border-radius:var(--r); padding:18px var(--pad); margin-bottom:14px; }
label{ display:block; font-size:13px; color:var(--ink-2); margin:10px 0 4px; }
input,select,textarea{ width:100%; font-family:inherit; font-size:16px; padding:10px 12px; border:1px solid var(--line-2); border-radius:var(--r); background:#fff; }
textarea{ min-height:90px; resize:vertical; }
.btn{ display:block; width:100%; background:var(--brand); color:#fff; border:0; border-radius:var(--r); padding:13px; font-size:16px; font-weight:600; cursor:pointer; margin-top:16px; }
.btn.ghost{ background:#fff; color:var(--ink); border:1px solid var(--line-2); }
.btn.brand{ background:var(--brand); }
.msg{ font-size:14px; margin-top:12px; } .msg.bad{ color:var(--bad); } .msg.ok{ color:var(--ok); }
.hint{ font-size:12px; color:var(--ink-3); margin-top:4px; }
.policybox{ font-size:12.5px; line-height:1.7; color:#7a4b00; background:#fff8e6; border:1px solid #f0c36d; border-radius:8px; padding:10px 12px; margin-top:10px; }
.hidden{ display:none; }
.sumrow{ display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-top:1px solid var(--line); font-size:14px; }
.sumrow:first-child{ border-top:0; } .sumrow .k{ color:var(--ink-2); }
.grid3{ display:grid; grid-template-columns:1.3fr 1fr 1fr; gap:8px; }
.nudge{ background:#eef6ff; border:1px solid #cfe3ff; border-radius:var(--r); padding:16px; margin-top:14px; }
.nudge h2{ font-size:15px; margin:0 0 6px; } .nudge p{ font-size:13px; color:var(--ink-2); margin:0 0 12px; }
a.link{ color:var(--brand); }
</style>
</head>
<body>
<header class="albe-topbar">
  <a class="albe-brand" href="https://space-albe.com/" aria-label="レンタルスペースALBE トップへ">
    <img class="albe-logo" src="/assets/albe-logo.png" alt="レンタルスペースALBE" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
    <span class="albe-brand-text">RENTAL SPACE ALBE</span>
  </a>
  <nav class="albe-nav"><a class="albe-contact" href="https://space-albe.com/contact/">お問い合わせ</a></nav>
</header>
<main>
  <h1>ご予約の確認・変更</h1>
  <p class="lede">会員登録なしでご予約されたお客様も、ご予約時の情報でご予約内容の確認・変更のご相談ができます。</p>

  <!-- Step 1: 本人確認 -->
  <div class="card" id="verifyCard">
    <label>予約番号 <span style="color:var(--bad)">*</span></label>
    <input id="f_num" placeholder="例）20260901-001" autocomplete="off" />
    <label>ご予約時のメールアドレス <span style="color:var(--bad)">*</span></label>
    <input id="f_email" type="email" placeholder="例）you@example.com" autocomplete="off" />
    <label>ご予約時の電話番号 <span style="color:var(--bad)">*</span></label>
    <input id="f_phone" type="tel" placeholder="例）090-1234-5678" autocomplete="off" />
    <div class="hint">3つすべてがご予約時の内容と一致すると、ご予約を呼び出せます。</div>
    <button class="btn" id="verifyBtn" onclick="doLookup()">予約を確認する</button>
    <div class="msg" id="vMsg"></div>
  </div>

  <!-- Step 2: 予約内容 + 変更リクエスト -->
  <div class="card hidden" id="reqCard">
    <div id="summary" style="margin-bottom:8px"></div>
    <label>ご希望の種別 <span style="color:var(--bad)">*</span></label>
    <select id="c_type" onchange="onTypeChange()">
      <option value="reschedule">日時の変更</option>
      <option value="option">オプションの変更</option>
      <option value="cancel">キャンセル</option>
      <option value="other">その他のご相談</option>
    </select>
    <div id="cancelPolicy" class="policybox hidden">
      <strong>キャンセルについて</strong><br>
      ・利用日の<b>3日前以降はオンラインでのキャンセルを承れません</b>。お手数ですがメールフォーム・お電話でご連絡ください。<br>
      ・キャンセル料：31日前まで無料／30〜15日前 50%／14日前〜前日 80%／当日 100%。キャンセル料が発生する場合は、お手続き前に担当者より金額をご案内します。
    </div>
    <div id="reschedulePolicy" class="policybox hidden">
      <strong>日時変更について</strong><br>
      ・31日前まで：当初ご予定日の前後1ヶ月以内へのお振替を承ります（空き次第）。<br>
      ・30日前以降：キャンセル＋新規のお取り扱いとなります。<br>
      ・利用時間を大幅に減らすご変更は、減少分にキャンセル料が発生する場合があります。
    </div>
    <div id="cancelBlock" class="msg bad hidden"></div>
    <div id="proposedWrap">
      <label>ご希望の日時（任意）</label>
      <div class="grid3">
        <input id="p_date" type="date" />
        <select id="p_start" onchange="onStartChange()"><option value="">開始</option></select>
        <select id="p_end"><option value="">終了</option></select>
      </div>
      <div class="hint">空きは店舗で確認のうえご連絡します（この時点では確定しません）。</div>
    </div>
    <label>ご希望・ご連絡事項 <span id="msgReq" style="color:var(--bad)">*</span></label>
    <textarea id="c_message" placeholder="例）9月3日の同じ時間に変更したいです。"></textarea>
    <button class="btn" id="submitBtn" onclick="doSubmit()">この内容で変更をリクエストする</button>
    <div class="msg" id="sMsg"></div>
  </div>

  <!-- Step 3: 完了 + 会員登録誘導 -->
  <div class="card hidden" id="doneCard">
    <div class="msg ok" style="font-size:16px;font-weight:600">✓ 変更リクエストを受け付けました</div>
    <p style="font-size:14px;color:var(--ink-2)">担当者が内容を確認し、メールでご連絡いたします。受付確認メールをお送りしました。</p>
    <div class="nudge">
      <h2>次回から、確認なしで変更できます</h2>
      <p>会員登録をすると、今回のご予約もそのままマイページに表示され、次回からは毎回の確認が不要になります。ご登録は入力済みの情報でかんたんです。</p>
      <a class="btn brand" id="registerLink" href="/mypage.html">会員登録する（かんたん）</a>
    </div>
    <a class="btn ghost" href="/" style="margin-top:10px">トップへ戻る</a>
  </div>
</main>

<script>
var $ = function(id){ return document.getElementById(id); };
var q = new URLSearchParams(location.search);
if (q.get('num')) $('f_num').value = q.get('num');

function creds(){ return { bookingNumber: $('f_num').value.trim(), email: $('f_email').value.trim(), phone: $('f_phone').value.trim() }; }
var _prefill = null;
var _hours = null; // 対象スペースの営業時間 {open, close, slot}
var _daysUntil = null; // 当初利用日までの残日数（#76）
var _cutoff = 4;       // これ未満（3日前以降）はオンラインキャンセル不可

function onTypeChange(){
  var t = $('c_type').value;
  $('proposedWrap').classList.toggle('hidden', t !== 'reschedule');
  $('msgReq').style.display = (t === 'cancel') ? 'none' : '';
  // ポリシーの事前表示（#76）
  $('cancelPolicy').classList.toggle('hidden', t !== 'cancel');
  $('reschedulePolicy').classList.toggle('hidden', t !== 'reschedule');
  // キャンセルは利用日の3日前以降オンライン受付不可 → その場で案内し送信不可に
  var blocked = (t === 'cancel') && (_daysUntil != null) && (_daysUntil < _cutoff);
  var cb = $('cancelBlock');
  if (blocked){
    cb.textContent = (_daysUntil <= 0)
      ? '当日のオンラインキャンセルは承っておりません。お手数ですがお電話・メールフォームよりご連絡ください。'
      : '利用日の3日前以降は、オンラインでのキャンセルを承っておりません。キャンセル料が発生する場合は手続き前に担当者より金額をご案内します。お手数ですがメールフォームよりご連絡ください。';
    cb.classList.remove('hidden');
    $('submitBtn').disabled = true;
  } else {
    cb.classList.add('hidden');
    $('submitBtn').disabled = false;
  }
}

// 対象スペースの営業時間内・30分刻みで開始/終了の選択肢を作る
function toMin(hhmm){ var p = (hhmm||'').split(':'); return (+p[0])*60 + (+p[1]||0); }
function fromMin(m){ return String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0'); }
function buildTimeOptions(){
  if (!_hours) return;
  var step = _hours.slot || 30;
  var openM = toMin(_hours.open), closeM = toMin(_hours.close);
  var startSel = $('p_start'), endSel = $('p_end');
  startSel.innerHTML = '<option value="">開始</option>';
  endSel.innerHTML = '<option value="">終了</option>';
  for (var t = openM; t <= closeM - step; t += step){ var o=document.createElement('option'); o.value=fromMin(t); o.textContent=fromMin(t); startSel.appendChild(o); }
  for (var e = openM + step; e <= closeM; e += step){ var o2=document.createElement('option'); o2.value=fromMin(e); o2.textContent=fromMin(e); endSel.appendChild(o2); }
}
// 開始を選んだら、終了は開始より後だけに絞る
function onStartChange(){
  if (!_hours) return;
  var step = _hours.slot || 30, sM = toMin($('p_start').value), closeM = toMin(_hours.close);
  var endSel = $('p_end'), cur = endSel.value;
  endSel.innerHTML = '<option value="">終了</option>';
  var from = $('p_start').value ? sM + step : toMin(_hours.open) + step;
  for (var e = from; e <= closeM; e += step){ var o=document.createElement('option'); o.value=fromMin(e); o.textContent=fromMin(e); endSel.appendChild(o); }
  if (cur && toMin(cur) > sM) endSel.value = cur;
}

async function doLookup(){
  var m = $('vMsg'); m.className='msg'; m.textContent='確認しています…';
  var c = creds();
  if (!c.bookingNumber || !c.email || !c.phone){ m.className='msg bad'; m.textContent='予約番号・メール・電話をすべて入力してください。'; return; }
  $('verifyBtn').disabled = true;
  try {
    var r = await fetch('/api/guest-change/lookup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(c) });
    var j = await r.json().catch(function(){ return {}; });
    if (r.status === 429){ m.className='msg bad'; m.textContent = j.error || 'しばらく時間をおいてお試しください。'; return; }
    if (!j.matched){ m.className='msg bad'; m.textContent = j.error || 'ご予約が確認できませんでした。'; return; }
    _prefill = j.prefill || null;
    _hours = j.spaceHours || null;
    _daysUntil = (typeof j.daysUntilUse === 'number') ? j.daysUntilUse : null;
    _cutoff = j.selfCancelCutoffDays || 4;
    buildTimeOptions();
    if (j.cancelled){ m.className='msg bad'; m.textContent='このご予約はキャンセル済みです。'; return; }
    // 予約内容を表示
    var b = j.booking || {};
    var dt = (b.items || []).map(function(i){ return i.date + ' ' + i.startTime + '〜' + i.endTime; }).join('<br>') || '—';
    $('summary').innerHTML =
      '<div class="sumrow"><span class="k">予約番号</span><span>' + (b.bookingNumber||'') + '</span></div>' +
      '<div class="sumrow"><span class="k">スペース</span><span>' + (b.spaceName||'') + '</span></div>' +
      '<div class="sumrow"><span class="k">ご利用日時</span><span style="text-align:right">' + dt + '</span></div>' +
      '<div class="sumrow"><span class="k">イベント名</span><span>' + (b.eventName||'—') + '</span></div>';
    $('verifyCard').classList.add('hidden');
    $('reqCard').classList.remove('hidden');
    onTypeChange();
  } catch(e){ m.className='msg bad'; m.textContent='通信に失敗しました。'; }
  finally { $('verifyBtn').disabled = false; }
}

async function doSubmit(){
  var m = $('sMsg'); m.className='msg'; m.textContent='送信しています…';
  var type = $('c_type').value;
  var message = $('c_message').value.trim();
  if (type !== 'cancel' && !message){ m.className='msg bad'; m.textContent='ご希望・ご連絡事項を入力してください。'; return; }
  var payload = Object.assign(creds(), { type: type, message: message });
  if (type === 'reschedule' && $('p_date').value && $('p_start').value && $('p_end').value){
    payload.proposedItems = [{ date: $('p_date').value, startTime: $('p_start').value.slice(0,5), endTime: $('p_end').value.slice(0,5) }];
  }
  $('submitBtn').disabled = true;
  try {
    var r = await fetch('/api/guest-change/request', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok || j.error){ m.className='msg bad'; m.textContent = j.error || '送信に失敗しました。'; $('submitBtn').disabled=false; return; }
    // 完了表示＋会員登録リンク（照合済み情報でプリフィル）
    if (_prefill){
      var p = new URLSearchParams({ register:'1', email:_prefill.email||'', name:_prefill.name||'', phone:_prefill.phone||'' });
      $('registerLink').href = '/mypage.html?' + p.toString();
    }
    $('reqCard').classList.add('hidden');
    $('doneCard').classList.remove('hidden');
    window.scrollTo(0,0);
  } catch(e){ m.className='msg bad'; m.textContent='通信に失敗しました。'; $('submitBtn').disabled=false; }
}
</script>
</body>
</html>
`;
