/*
 * ALBE 施設カレンダー埋め込みウィジェット（#19）
 * -----------------------------------------------------------------------------
 * 外部サイト（例: 名駅フリースペース / アルベホール名古屋）に、その施設だけの
 * 月間カレンダー（空き ○△✕）を貼り付ける。日付クリックで予約画面が新規タブで開く。
 * 貼るだけで高さは自動調整（iframe の postMessage を受けてリサイズ）。
 *
 * 使い方（サイトのHTMLに貼るだけ）:
 *
 *   1) 表示したい場所に div を置く（data-albe-calendar に スペースの slug または id）:
 *      <div data-albe-calendar="meieki-free"></div>
 *
 *   2) ページ末尾でこのスクリプトを1回だけ読み込む（data-api は本番なら省略可）:
 *      <script src="https://booking.space-albe.com/assets/calendar-embed.js" defer></script>
 *
 *   月を指定して開きたい場合（任意）:
 *      <div data-albe-calendar="meieki-free" data-month="2026-10"></div>
 *
 * スペースID/slug一覧は price-embed.js のコメント、または管理画面のスペース一覧を参照。
 * ※ スクリプトを使わず iframe を直接貼ることも可能（高さは固定になる）:
 *   <iframe src="https://booking.space-albe.com/embed/calendar?space=meieki-free"
 *           style="width:100%;max-width:560px;height:520px;border:0" loading="lazy"></iframe>
 */
(function () {
  'use strict';

  // 参照先（予約システム）のオリジンを決定：script[data-api] → window.ALBE_CAL_API → 既定(本番)
  function resolveBase() {
    try {
      var s = document.querySelector('script[src*="calendar-embed.js"]');
      if (s && s.getAttribute('data-api')) return s.getAttribute('data-api').replace(/\/$/, '');
    } catch (e) {}
    if (window.ALBE_CAL_API) return String(window.ALBE_CAL_API).replace(/\/$/, '');
    return 'https://booking.space-albe.com';
  }
  var BASE = resolveBase();

  // iframe ごとに一意の名前を振り、postMessage の高さ通知を対応する iframe に紐づける
  var seq = 0;
  var frames = {}; // name -> iframe要素

  function mount(el) {
    if (el.getAttribute('data-albe-mounted')) return;
    var key = el.getAttribute('data-albe-calendar');
    if (!key) return;
    el.setAttribute('data-albe-mounted', '1');

    var name = 'albe-cal-' + (++seq);
    var src = BASE + '/embed/calendar?space=' + encodeURIComponent(key);
    var month = el.getAttribute('data-month');
    if (month && /^\d{4}-\d{2}$/.test(month)) src += '&month=' + month;

    var iframe = document.createElement('iframe');
    iframe.name = name;
    iframe.src = src;
    iframe.loading = 'lazy';
    iframe.setAttribute('title', 'ALBE 空き状況カレンダー');
    iframe.style.width = '100%';
    iframe.style.maxWidth = '560px';
    iframe.style.height = '520px'; // 読み込み後に自動調整
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.margin = '0 auto';
    frames[name] = iframe;
    el.appendChild(iframe);
  }

  function mountAll() {
    var nodes = document.querySelectorAll('[data-albe-calendar]');
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }

  // 子（カレンダー）からの高さ通知を受けて、該当 iframe の高さを合わせる
  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || typeof d !== 'object' || typeof d.albeCalHeight !== 'number') return;
    // 送信元 iframe を特定（source が一致するものを探す）
    for (var name in frames) {
      var f = frames[name];
      if (f && f.contentWindow === ev.source) {
        var h = Math.max(200, Math.min(2000, Math.round(d.albeCalHeight)));
        f.style.height = h + 'px';
        break;
      }
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAll);
  } else {
    mountAll();
  }
})();
