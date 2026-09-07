/*
 * ALBE 料金連動ウィジェット（公式サイト埋め込み用・#19関連）
 * -----------------------------------------------------------------------------
 * 予約システムの公開API（/api/spaces）から最新の料金を取得し、公式サイト（静的HTML）の
 * 指定箇所へ流し込む。管理画面で料金を変更すると、公式サイトの表示も自動で連動する。
 *
 * 使い方（公式サイトのHTMLに貼るだけ）:
 *
 *   1) 全スペースの料金表を自動生成:
 *      <div data-albe-price-table></div>
 *
 *   2) 個別の値を差し込む（data-albe-price に スペースID、data-field に項目）:
 *      <span data-albe-price="meieki-free" data-field="weekday"></span>   … 平日料金 例)¥4,840/時
 *      <span data-albe-price="meieki-free" data-field="weekend"></span>   … 土日祝料金
 *      <span data-albe-price="meieki-free" data-field="from"></span>      … 開始料金（最安の時間単価）例)¥4,840/時（英語ページ用のFROM列に最適）
 *      <span data-albe-price="meieki-free" data-field="min"></span>       … 最低利用時間 例)3時間
 *      <span data-albe-price="meieki-free" data-field="hours"></span>     … 営業時間 例)08:00–22:00
 *      <span data-albe-price="meieki-free" data-field="name"></span>      … スペース名
 *      <span data-albe-price="meieki-free" data-field="rate"></span>      … 平日〜 の簡易表記 例)¥4,840/時〜
 *
 *   2-a) 英語ページ用の表記（/時→/h、時間→hours、要問合せ→Ask us）:
 *      ・ページ全体を英語にする場合は script タグに data-lang="en" を付ける（下記4）。
 *      ・個別に切り替える場合は要素に data-lang="en" を付ける:
 *        <span data-albe-price="meieki-free" data-field="from" data-lang="en"></span>  … 例)¥4,840/h
 *
 *   3) 「予約する」ボタンのリンクを自動設定（対象スペースの予約画面へ）:
 *      <a data-albe-link="meieki-free">予約する</a>
 *
 *   4) ページ末尾で読み込み（1回だけ）。data-api で参照先、data-lang で言語（省略時 ja）:
 *      <script src="https://booking.space-albe.com/assets/price-embed.js"
 *              data-api="https://booking.space-albe.com" data-lang="en" defer></script>
 *
 * スペースID一覧:
 *   meieki-free（名駅フリースペース） / meieki-exercise（名駅エクササイズ）
 *   meieki-washitsu（名駅和室） / meieki-piano-a（名駅防音室A） / meieki-piano-b（名駅防音室B）
 *   higashibetsuin-piano-24h（東別院24hピアノ練習室）
 *   ※ id の代わりにスペースの slug でも指定可。
 */
(function () {
  'use strict';

  // 参照先（予約システム）のオリジンを決定：script[data-api] → window.ALBE_PRICE_API → 既定(本番)
  function resolveBase() {
    try {
      var s = document.querySelector('script[src*="price-embed.js"]');
      if (s && s.getAttribute('data-api')) return s.getAttribute('data-api').replace(/\/$/, '');
    } catch (e) {}
    if (window.ALBE_PRICE_API) return String(window.ALBE_PRICE_API).replace(/\/$/, '');
    return 'https://booking.space-albe.com';
  }
  var BASE = resolveBase();

  // 表示言語（既定 ja）。script[data-lang] → window.ALBE_PRICE_LANG → 'ja'。
  // 要素ごとに data-lang を付ければ個別に上書きできる。
  function resolveLang() {
    try {
      var s = document.querySelector('script[src*="price-embed.js"]');
      if (s && s.getAttribute('data-lang')) return String(s.getAttribute('data-lang')).toLowerCase();
    } catch (e) {}
    if (window.ALBE_PRICE_LANG) return String(window.ALBE_PRICE_LANG).toLowerCase();
    return 'ja';
  }
  var LANG = resolveLang();
  var isEn = function (lang) { return (lang || LANG) === 'en'; };

  var yen = function (n) { return '¥' + Number(n || 0).toLocaleString('ja-JP'); };
  // 時間単価の単位：時間貸しのみ付ける（en=/h, ja=/時）。それ以外（block等）は付けない。
  var unit = function (sp, lang) { return sp.billingType === 'hourly' ? (isEn(lang) ? '/h' : '/時') : ''; };
  var quoteLabel = function (lang) { return isEn(lang) ? 'Ask us' : '要問合せ'; };
  var minLabel = function (sp, lang) {
    if (!(sp.hasMinimum && sp.minHours)) return '—';
    return isEn(lang) ? (sp.minHours + (sp.minHours === 1 ? ' hour' : ' hours')) : (sp.minHours + '時間');
  };
  // 開始料金（FROM）：平日・土日祝のうち有効な最安の時間単価。無ければ／申込がお問い合わせのみなら要問合せ。
  function startingRate(sp) {
    var rates = [sp.weekdayRate, sp.weekendRate].filter(function (r) { return typeof r === 'number' && r > 0; });
    return rates.length ? Math.min.apply(null, rates) : null;
  }

  function fieldValue(sp, field, lang) {
    switch (field) {
      case 'name': return sp.name;
      case 'weekday': return yen(sp.weekdayRate) + unit(sp, lang);
      case 'weekend': return yen(sp.weekendRate) + unit(sp, lang);
      case 'from': {
        if (sp.inquiryOnly) return quoteLabel(lang);
        var r = startingRate(sp);
        return r != null ? yen(r) + unit(sp, lang) : quoteLabel(lang);
      }
      case 'rate': return (sp.weekdayRate ? yen(sp.weekdayRate) + unit(sp, lang) + '〜' : quoteLabel(lang));
      case 'min': return minLabel(sp, lang);
      case 'hours': return (sp.openTime || '') + '–' + (sp.closeTime || '');
      case 'open': return sp.openTime || '';
      case 'close': return sp.closeTime || '';
      default: return '';
    }
  }

  function renderTable(el, spaces) {
    var lang = el.getAttribute('data-lang') || LANG;
    var en = isEn(lang);
    var head = en
      ? ['Space', 'Weekday', 'Weekend/Holiday', 'Min. use', 'Hours']
      : ['スペース', '平日', '土日祝', '最低利用', '営業時間'];
    var note = en
      ? 'Prices include tax. See live prices and availability on the booking page.'
      : '表示価格は税込です。最新の料金は予約画面でご確認いただけます。';
    // 平日と土日祝が同額のスペースは1列にまとめて見やすくする
    var rows = spaces.map(function (sp) {
      var wd = yen(sp.weekdayRate) + unit(sp, lang);
      var we = yen(sp.weekendRate) + unit(sp, lang);
      var priceCell = (sp.weekdayRate === sp.weekendRate)
        ? '<td class="albe-pt-price" colspan="2" style="text-align:center">' + wd + '</td>'
        : '<td class="albe-pt-price">' + wd + '</td><td class="albe-pt-price">' + we + '</td>';
      return '<tr><th scope="row" class="albe-pt-name">' + sp.name + '</th>' + priceCell +
        '<td class="albe-pt-min">' + minLabel(sp, lang) + '</td>' +
        '<td class="albe-pt-hours">' + (sp.openTime || '') + '–' + (sp.closeTime || '') + '</td></tr>';
    }).join('');
    el.innerHTML =
      '<table class="albe-price-table">' +
      '<thead><tr><th>' + head[0] + '</th><th>' + head[1] + '</th><th>' + head[2] + '</th><th>' + head[3] + '</th><th>' + head[4] + '</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<p class="albe-pt-note">' + note + '</p>';
  }

  function injectTableStyle() {
    if (document.getElementById('albe-price-style')) return;
    var css =
      '.albe-price-table{width:100%;border-collapse:collapse;font-size:14px}' +
      '.albe-price-table th,.albe-price-table td{border:1px solid #e5e2dc;padding:8px 10px;text-align:center}' +
      '.albe-price-table thead th{background:#f4f6f8;font-weight:700}' +
      '.albe-price-table .albe-pt-name{text-align:left;white-space:nowrap;font-weight:700}' +
      '.albe-price-table .albe-pt-price{font-variant-numeric:tabular-nums}' +
      '.albe-pt-note{font-size:12px;color:#6f6c66;margin:6px 0 0}';
    var st = document.createElement('style');
    st.id = 'albe-price-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function apply(spaces) {
    var byKey = {};
    spaces.forEach(function (sp) { byKey[sp.id] = sp; if (sp.slug) byKey[sp.slug] = sp; });

    // 個別の値
    document.querySelectorAll('[data-albe-price]').forEach(function (el) {
      var sp = byKey[el.getAttribute('data-albe-price')];
      if (!sp) return;
      var v = fieldValue(sp, el.getAttribute('data-field') || 'rate', el.getAttribute('data-lang') || LANG);
      if (v != null) el.textContent = v;
    });
    // 予約リンク
    document.querySelectorAll('[data-albe-link]').forEach(function (el) {
      var sp = byKey[el.getAttribute('data-albe-link')];
      if (!sp) return;
      el.setAttribute('href', BASE + '/?space=' + encodeURIComponent(sp.id));
    });
    // 全スペース料金表
    var tables = document.querySelectorAll('[data-albe-price-table]');
    if (tables.length) {
      injectTableStyle();
      tables.forEach(function (el) { renderTable(el, spaces); });
    }
  }

  function start() {
    fetch(BASE + '/api/spaces', { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && Array.isArray(data.spaces)) apply(data.spaces);
      })
      .catch(function () { /* 取得失敗時は静かに何もしない（既存の静的表示のまま） */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
