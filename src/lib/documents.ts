/**
 * 請求書・領収書のHTML生成（純関数・テスト可能）
 *
 * PDFは「印刷最適化HTML → ブラウザのPDF保存」方式。
 * Cloudflare Workers 上で重量級PDFライブラリ（CJKフォント埋め込み）を避け、
 * 日本語を確実に扱うための実装方針。
 */

export type DocumentType = 'invoice' | 'receipt';

export interface IssuerInfo {
  name: string; // 事業者名（会社名）
  zip?: string; // 郵便番号
  address?: string; // 住所
  tel?: string; // 電話
  email?: string; // メール
  invoiceRegNo?: string; // 適格請求書発行事業者登録番号（T+13桁）
  bankInfo?: string; // 振込先（複数行可）
  note?: string; // 備考
}

export interface DocumentItem {
  date: string;
  startTime: string;
  endTime: string;
}

export interface DocumentData {
  type: DocumentType;
  documentNumber: string; // 書類番号
  issuedDate: string; // 発行日 YYYY-MM-DD
  bookingNumber: string;
  recipientName: string; // 宛名
  spaceName: string;
  eventName: string;
  items: DocumentItem[];
  total: number; // 税込合計
  paymentMethodLabel: string; // 支払い方法の表示名
  issuer: IssuerInfo;
  /** サーバー側PDF生成が有効なとき、ダウンロード用リンク（例: '?format=pdf'）。未指定なら印刷ボタンのみ。 */
  pdfHref?: string;
  /** メール送信APIのパス（例: '/api/documents/<token>/email'）。設定時のみ「メールで送信」ボタンを表示。 */
  mailApiPath?: string;
  /** メール送信フォームの既定の宛先（顧客の登録メール）。 */
  defaultEmail?: string;
}

/** 税込金額から消費税(10%)を割り戻す */
export function taxBreakdown(totalIncl: number): { net: number; tax: number; total: number } {
  const total = Math.round(totalIncl);
  const tax = Math.round((total * 10) / 110);
  return { net: total - tax, tax, total };
}

const yen = (n: number): string => '¥' + Number(n || 0).toLocaleString('ja-JP');
const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const nl2br = (s: unknown): string => esc(s).replace(/\r?\n/g, '<br>');

/** 書類（請求書 or 領収書）のHTMLを生成 */
export function renderDocumentHtml(d: DocumentData): string {
  const isReceipt = d.type === 'receipt';
  const title = isReceipt ? '領収書' : '請求書';
  const { net, tax, total } = taxBreakdown(d.total);
  const amountLabel = isReceipt ? '領収金額' : 'ご請求金額';

  const rows = d.items
    .map(
      (i) =>
        `<tr><td>${esc(d.spaceName)} ご利用</td><td class="c">${esc(i.date)}</td><td class="c">${esc(i.startTime)}〜${esc(
          i.endTime,
        )}</td></tr>`,
    )
    .join('');

  const issuer = d.issuer;
  const issuerLines = [
    issuer.zip ? '〒' + esc(issuer.zip) : '',
    esc(issuer.address),
    issuer.tel ? 'TEL: ' + esc(issuer.tel) : '',
    issuer.email ? esc(issuer.email) : '',
    issuer.invoiceRegNo ? '登録番号: ' + esc(issuer.invoiceRegNo) : '',
  ]
    .filter(Boolean)
    .join('<br>');

  // 領収書は「但し書き＋受領文」、請求書は「振込先＋お支払いのお願い」
  const bodyBlock = isReceipt
    ? `<div class="note-box">
         <div class="but">但し、レンタルスペースご利用料金として</div>
         <div>上記正に領収いたしました。</div>
         <div class="mini">※本領収書は電子的に発行されたものです（収入印紙は不要です）。</div>
       </div>`
    : `<div class="note-box">
         <div>下記の内容にてご請求申し上げます。お手数ですが下記お振込先までお願いいたします。</div>
         ${issuer.bankInfo ? `<div class="bank"><div class="bank-h">お振込先</div>${nl2br(issuer.bankInfo)}</div>` : ''}
       </div>`;

  return `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} ${esc(d.documentNumber)}</title>
<style>
  :root { --ink:#1a1a1a; --muted:#6b7280; --line:#d1d5db; --brand:#1f6feb; }
  * { box-sizing:border-box; }
  body { margin:0; background:#eceef1; color:var(--ink); font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif; line-height:1.6; }
  .toolbar { text-align:center; padding:14px; }
  .toolbar button, .toolbar .btn-dl { background:var(--brand); color:#fff; border:0; border-radius:8px; padding:11px 22px; font-size:15px; cursor:pointer; display:inline-block; text-decoration:none; }
  .toolbar .btn-dl { margin-right:8px; }
  .toolbar .btn-print { background:#fff; color:var(--brand); border:1px solid var(--brand); }
  .toolbar .btn-mail { background:#fff; color:var(--brand); border:1px solid var(--brand); }
  .toolbar .tb-row { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; }
  .toolbar .hint { color:var(--muted); font-size:12px; margin-top:8px; }
  .toolbar .mailform { max-width:420px; margin:12px auto 0; text-align:left; }
  .toolbar .mailrow { display:flex; gap:8px; }
  .toolbar .mailform input { flex:1; padding:10px; border:1px solid var(--line); border-radius:8px; font-size:14px; }
  .toolbar .btn-send { background:var(--brand); color:#fff; border:0; border-radius:8px; padding:10px 18px; font-size:14px; cursor:pointer; }
  .toolbar .mailnote { color:var(--muted); font-size:11px; margin-top:6px; }
  .toolbar .mailmsg { font-size:13px; margin-top:6px; min-height:18px; }
  .toolbar .mailmsg.ok { color:#0f7b3f; }
  .toolbar .mailmsg.bad { color:#c02a1e; }
  .sheet { background:#fff; width:210mm; max-width:96vw; margin:0 auto 30px; padding:18mm 16mm; box-shadow:0 2px 12px rgba(0,0,0,.12); }
  h1 { text-align:center; font-size:28px; letter-spacing:.4em; margin:0 0 6px; padding-left:.4em; }
  .doc-meta { text-align:right; font-size:12px; color:var(--muted); }
  .head { display:flex; justify-content:space-between; gap:20px; margin-top:18px; }
  .recipient { flex:1; }
  .recipient .to { font-size:18px; font-weight:700; border-bottom:2px solid var(--ink); padding-bottom:4px; display:inline-block; min-width:60%; }
  .recipient .sub { font-size:12px; color:var(--muted); margin-top:8px; }
  .issuer { flex:0 0 auto; text-align:right; font-size:12px; position:relative; padding-right:78px; }
  .issuer .name { font-size:15px; font-weight:700; margin-bottom:4px; }
  /* 社印（角印）：発行者情報の右側に配置。用意が無ければ非表示（onerror） */
  .issuer .seal { position:absolute; top:-4px; right:-6px; width:70px; height:70px; object-fit:contain; opacity:.92;
    mix-blend-mode:multiply; -webkit-print-color-adjust:exact; print-color-adjust:exact; pointer-events:none; }
  .amount { margin:22px 0; border:2px solid var(--ink); border-radius:6px; padding:12px 16px; display:flex; justify-content:space-between; align-items:center; }
  .amount .lbl { font-size:15px; font-weight:700; }
  .amount .val { font-size:26px; font-weight:800; }
  table { width:100%; border-collapse:collapse; margin-top:10px; font-size:13px; }
  th, td { border:1px solid var(--line); padding:8px 10px; text-align:left; }
  th { background:#f3f4f6; }
  td.c, th.c { text-align:center; }
  .totals { margin-top:12px; margin-left:auto; width:min(280px,100%); font-size:13px; }
  .totals .row { display:flex; justify-content:space-between; padding:5px 2px; border-bottom:1px dashed var(--line); }
  .totals .row.grand { border-bottom:0; border-top:2px solid var(--ink); font-weight:800; font-size:15px; margin-top:2px; padding-top:8px; }
  .note-box { margin-top:20px; font-size:13px; }
  .note-box .but { font-weight:700; margin-bottom:2px; }
  .note-box .mini { color:var(--muted); font-size:11px; margin-top:6px; }
  .bank { margin-top:10px; border:1px solid var(--line); border-radius:6px; padding:10px 12px; background:#fafafa; }
  .bank-h { font-weight:700; margin-bottom:2px; }
  .foot { margin-top:24px; font-size:12px; color:var(--muted); }
  /* スマホ表示：A4固定幅で見切れないよう、余白を詰めて縦積みにする（印刷時はA4のまま） */
  @media screen and (max-width:640px) {
    .sheet { width:auto; max-width:none; padding:20px 16px; margin:0 8px 24px; }
    h1 { font-size:22px; letter-spacing:.3em; }
    .doc-meta { font-size:11px; }
    .head { flex-direction:column; gap:12px; margin-top:14px; }
    .recipient .to { min-width:0; font-size:16px; }
    .issuer { text-align:left; padding-right:0; overflow-wrap:anywhere; }
    .issuer .name { font-size:14px; }
    .issuer .seal { position:static; display:block; margin:10px 0 0; }
    .amount { padding:10px 12px; }
    .amount .val { font-size:22px; }
    table { font-size:12px; }
    th, td { padding:6px 6px; }
    .totals { width:100%; }
  }
  @media print {
    body { background:#fff; }
    .toolbar { display:none; }
    .sheet { box-shadow:none; margin:0 auto; width:auto; max-width:none; padding:0; }
    @page { size:A4; margin:16mm; }
  }
</style>
</head><body>
  <div class="toolbar">
    <div class="tb-row">
      ${d.pdfHref
        ? `<a class="btn-dl" href="${esc(d.pdfHref)}">⬇ PDFをダウンロード</a>
           <button class="btn-print" onclick="window.print()">🖨 印刷</button>`
        : `<button onclick="window.print()">🖨 PDFとして保存 / 印刷</button>`}
      ${d.mailApiPath ? `<button class="btn-mail" onclick="toggleMail()">✉ メールで送信</button>` : ''}
    </div>
    <div class="hint">${d.pdfHref
      ? 'スマホは「PDFをダウンロード」がおすすめです。PCでは「印刷」→「PDFに保存」も使えます。'
      : 'ボタンから「送信先：PDFに保存」を選ぶとPDFで保存できます。スマホで動かない場合は、Safari / Chrome で開いてお試しください。'}</div>
    ${d.mailApiPath
      ? `<div id="mailForm" class="mailform" style="display:none">
           <div class="mailrow">
             <input id="mailTo" type="email" value="${esc(d.defaultEmail || '')}" placeholder="送信先メールアドレス" />
             <button class="btn-send" id="mailSend" onclick="sendMail()">送信</button>
           </div>
           <div class="mailnote">既定はご登録のメールアドレスです。変更する場合は上書きしてください。</div>
           <div id="mailMsg" class="mailmsg"></div>
         </div>`
      : ''}
  </div>
  <div class="sheet">
    <h1>${title}</h1>
    <div class="doc-meta">発行日：${esc(d.issuedDate)}<br>${title}番号：${esc(d.documentNumber)}<br>予約番号：${esc(
      d.bookingNumber,
    )}</div>
    <div class="head">
      <div class="recipient">
        <span class="to">${esc(d.recipientName)} 御中</span>
        <div class="sub">件名：${esc(d.eventName) || '—'}</div>
      </div>
      <div class="issuer">
        <div class="name">${esc(issuer.name)}</div>
        ${issuerLines}
        <img class="seal" src="/assets/company-seal.png" alt="社印" onerror="this.style.display='none'">
      </div>
    </div>
    <div class="amount">
      <span class="lbl">${amountLabel}（税込）</span>
      <span class="val">${yen(total)}</span>
    </div>
    ${bodyBlock}
    <table>
      <thead><tr><th>内容</th><th class="c">利用日</th><th class="c">時間</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" class="c">—</td></tr>'}</tbody>
    </table>
    <div class="totals">
      <div class="row"><span>小計（税抜）</span><span>${yen(net)}</span></div>
      <div class="row"><span>消費税（10%）</span><span>${yen(tax)}</span></div>
      <div class="row grand"><span>合計（税込）</span><span>${yen(total)}</span></div>
    </div>
    <div class="foot">お支払い方法：${esc(d.paymentMethodLabel)}${
      issuer.note ? '<br>' + nl2br(issuer.note) : ''
    }</div>
  </div>
  ${d.mailApiPath
    ? `<script>
  function toggleMail(){var f=document.getElementById('mailForm');f.style.display=(f.style.display==='none')?'':'none';if(f.style.display===''){var i=document.getElementById('mailTo');if(i)i.focus();}}
  async function sendMail(){
    var to=(document.getElementById('mailTo').value||'').trim();
    var msg=document.getElementById('mailMsg'),btn=document.getElementById('mailSend');
    if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(to)){msg.className='mailmsg bad';msg.textContent='メールアドレスの形式が正しくありません';return;}
    btn.disabled=true;msg.className='mailmsg';msg.textContent='送信中…';
    try{
      var r=await fetch(${JSON.stringify(d.mailApiPath)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:to})});
      var b=await r.json().catch(function(){return {};});
      if(r.ok){msg.className='mailmsg ok';msg.textContent=(b.sentTo||to)+' に送信しました。';}
      else{msg.className='mailmsg bad';msg.textContent=b.error||'送信に失敗しました';}
    }catch(e){msg.className='mailmsg bad';msg.textContent='送信に失敗しました';}
    btn.disabled=false;
  }
</script>`
    : ''}
</body></html>`;
}
