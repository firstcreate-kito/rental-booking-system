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
 *      <span data-albe-price="meieki-free" data-field="min"></span>       … 最低利用時間 例)3時間
 *      <span data-albe-price="meieki-free" data-field="hours"></span>     … 営業時間 例)08:00–22:00
 *      <span data-albe-price="meieki-free" data-field="name"></span>      … スペース名
 *      <span data-albe-price="meieki-free" data-field="rate"></span>      … 平日〜 の簡易表記 例)¥4,840/時〜
 *
 *   3) 「予約する」ボタンのリンクを自動設定（対象スペースの予約画面へ）:
 *      <a data-albe-link="meieki-free">予約する</a>
 *
 *   4) ページ末尾で読み込み（1回だけ）。data-api で参照先を指定（本番なら省略可）:
 *      <script src="https://booking.space-albe.com/assets/price-embed.js"
 *              data-api="https://booking.space-albe.com" defer></script>
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

  var yen = function (n) { return '¥' + Number(n || 0).toLocaleString('ja-JP'); };
  var unit = function (sp) { return sp.billingType === 'hourly' ? '/時' : ''; };

  function fieldValue(sp, field) {
    switch (field) {
      case 'name': return sp.name;
      case 'weekday': return yen(sp.weekdayRate) + unit(sp);
      case 'weekend': return yen(sp.weekendRate) + unit(sp);
      case 'rate': return (sp.weekdayRate ? yen(sp.weekdayRate) + unit(sp) + '〜' : '要問合せ');
      case 'min': return sp.hasMinimum && sp.minHours ? sp.minHours + '時間' : '—';
      case 'hours': return (sp.openTime || '') + '–' + (sp.closeTime || '');
      case 'open': return sp.openTime || '';
      case 'close': return sp.closeTime || '';
      default: return '';
    }
  }

  function renderTable(el, spaces) {
    // 平日と土日祝が同額のスペースは1列にまとめて見やすくする
    var rows = spaces.map(function (sp) {
      var wd = yen(sp.weekdayRate) + unit(sp);
      var we = yen(sp.weekendRate) + unit(sp);
      var priceCell = (sp.weekdayRate === sp.weekendRate)
        ? '<td class="albe-pt-price" colspan="2" style="text-align:center">' + wd + '</td>'
        : '<td class="albe-pt-price">' + wd + '</td><td class="albe-pt-price">' + we + '</td>';
      var min = (sp.hasMinimum && sp.minHours) ? sp.minHours + '時間' : '—';
      return '<tr><th scope="row" class="albe-pt-name">' + sp.name + '</th>' + priceCell +
        '<td class="albe-pt-min">' + min + '</td>' +
        '<td class="albe-pt-hours">' + (sp.openTime || '') + '–' + (sp.closeTime || '') + '</td></tr>';
    }).join('');
    el.innerHTML =
      '<table class="albe-price-table">' +
      '<thead><tr><th>スペース</th><th>平日</th><th>土日祝</th><th>最低利用</th><th>営業時間</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<p class="albe-pt-note">表示価格は税込です。最新の料金は予約画面でご確認いただけます。</p>';
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
      var v = fieldValue(sp, el.getAttribute('data-field') || 'rate');
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
