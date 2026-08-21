/*
 * ALBE PWA 補助スクリプト
 *  1) Service Worker を登録（オフライン表示・インストール要件のため）
 *  2) スマホに「ホーム画面に追加」を案内する控えめなバナーを表示
 *     - Android/Chrome : beforeinstallprompt を捕捉して「インストール」ボタンで追加
 *     - iOS/Safari      : 共有ボタン→「ホーム画面に追加」の手順を案内（自動追加はOS非対応）
 *  一度閉じると localStorage に記録し、再表示しない。既にアプリ起動中なら何も出さない。
 */
(function () {
  'use strict';

  // 1) Service Worker 登録
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {/* 失敗しても通常のWebとして動作 */});
    });
  }

  // 2) インストール案内バナー
  var DISMISS_KEY = 'albe_pwa_hint_dismissed';

  // 既にホーム画面から「アプリとして」起動している場合は案内不要
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
  if (standalone) return;

  // 端末判定
  var ua = navigator.userAgent || '';
  var isIOS = /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS はデスクトップ表示でUAにMacと出るため、タッチ有無で補完
    (/Macintosh/.test(ua) && 'ontouchend' in document);
  var isAndroid = /android/i.test(ua);
  if (!isIOS && !isAndroid) return; // PCでは出さない（ホーム追加の概念が薄いため）

  // iOSで「ホーム画面に追加」が使えるのは Safari のみ（Chrome=CriOS 等では不可）
  var iOSOtherBrowser = isIOS && /CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  if (iOSOtherBrowser) return;

  try { if (localStorage.getItem(DISMISS_KEY)) return; } catch (e) {}

  var shown = false;
  var deferredPrompt = null;

  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) {}
    var el = document.getElementById('albe-pwa-hint');
    if (el) el.remove();
  }

  function injectStyles() {
    if (document.getElementById('albe-pwa-style')) return;
    var css =
      '#albe-pwa-hint{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:460px;margin:0 auto;' +
      'background:#fff;color:var(--ink,#1a1917);border:1px solid var(--line,#e5e2dc);border-radius:14px;' +
      'box-shadow:0 8px 30px rgba(20,18,15,.18);padding:14px 14px 14px 16px;' +
      'font-family:var(--f-sans,-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif);' +
      'display:flex;gap:12px;align-items:flex-start;animation:albe-pwa-in .28s ease}' +
      '@keyframes albe-pwa-in{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}' +
      '#albe-pwa-hint .ic{flex:0 0 auto;width:40px;height:40px;border-radius:10px;background:var(--key-w,#eef5fb);' +
      'display:flex;align-items:center;justify-content:center;font-size:22px}' +
      '#albe-pwa-hint .bd{flex:1;min-width:0}' +
      '#albe-pwa-hint .ti{font-size:14px;font-weight:700;margin:1px 0 3px}' +
      '#albe-pwa-hint .tx{font-size:12.5px;color:var(--ink-2,#6f6c66);line-height:1.6}' +
      '#albe-pwa-hint .tx b{color:var(--key,#0068b7)}' +
      '#albe-pwa-hint .share{display:inline-flex;width:17px;height:17px;vertical-align:-3px;margin:0 1px}' +
      '#albe-pwa-hint .row{display:flex;gap:8px;margin-top:10px}' +
      '#albe-pwa-hint button.act{background:var(--key,#0068b7);color:#fff;border:0;border-radius:9px;' +
      'padding:9px 16px;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit}' +
      '#albe-pwa-hint button.later{background:transparent;color:var(--ink-2,#6f6c66);border:0;' +
      'padding:9px 8px;font-size:13px;cursor:pointer;font-family:inherit}' +
      '#albe-pwa-hint .x{flex:0 0 auto;background:transparent;border:0;color:var(--ink-3,#a8a49c);' +
      'font-size:20px;line-height:1;cursor:pointer;padding:2px 4px;margin:-4px -2px 0 0}';
    var s = document.createElement('style');
    s.id = 'albe-pwa-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // iOSの共有アイコン（□に上矢印）SVG
  var SHARE_SVG =
    '<svg class="share" viewBox="0 0 24 24" fill="none" stroke="#0068b7" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 15V3M12 3l-4 4M12 3l4 4"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/></svg>';

  function render(mode) {
    if (shown) return;
    shown = true;
    injectStyles();

    var box = document.createElement('div');
    box.id = 'albe-pwa-hint';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'ホーム画面に追加のご案内');

    var inner;
    if (mode === 'android') {
      inner =
        '<div class="ic">📲</div>' +
        '<div class="bd">' +
        '<div class="ti">ホーム画面に追加できます</div>' +
        '<div class="tx">アイコンから、アプリのように予約画面をすぐ開けます。</div>' +
        '<div class="row"><button class="act" id="albe-pwa-install">ホームに追加</button>' +
        '<button class="later" id="albe-pwa-later">あとで</button></div>' +
        '</div>' +
        '<button class="x" id="albe-pwa-x" aria-label="閉じる">×</button>';
    } else {
      // iOS
      inner =
        '<div class="ic">📲</div>' +
        '<div class="bd">' +
        '<div class="ti">ホーム画面に追加すると便利です</div>' +
        '<div class="tx">下の共有ボタン ' + SHARE_SVG +
        ' を押し、<b>「ホーム画面に追加」</b>を選ぶと、アプリのように使えます。</div>' +
        '<div class="row"><button class="later" id="albe-pwa-later">閉じる</button></div>' +
        '</div>' +
        '<button class="x" id="albe-pwa-x" aria-label="閉じる">×</button>';
    }
    box.innerHTML = inner;
    document.body.appendChild(box);

    var x = document.getElementById('albe-pwa-x');
    var later = document.getElementById('albe-pwa-later');
    if (x) x.addEventListener('click', dismiss);
    if (later) later.addEventListener('click', dismiss);

    if (mode === 'android') {
      var btn = document.getElementById('albe-pwa-install');
      if (btn) btn.addEventListener('click', function () {
        if (!deferredPrompt) { dismiss(); return; }
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(function () { deferredPrompt = null; dismiss(); });
      });
    }
  }

  // Android/Chrome：インストール可能になったら捕捉して表示
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    render('android');
  });

  // インストール完了後は二度と出さない
  window.addEventListener('appinstalled', dismiss);

  // iOS：beforeinstallprompt が無いので、少し待ってから手動手順を案内
  if (isIOS) {
    window.addEventListener('load', function () {
      setTimeout(function () { render('ios'); }, 1500);
    });
  }
})();
