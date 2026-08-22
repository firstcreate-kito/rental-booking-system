/*
 * Google Analytics 4（GA4）計測タグ
 *  - WEBサイト(space-albe.com)と同じ測定IDを使い、クロスドメインで一連の行動を計測する。
 *    ※クロスドメインの有効化は GA4 管理画面でのドメイン登録が別途必要（下記メモ参照）。
 *  - 予約システムの顧客向けページに共通で読み込む（管理画面 admin は対象外）。
 *  - ローカル開発(localhost)では送信しない（本番データを汚さないため）。
 *
 * GA4管理画面での設定（1回だけ・GAにアクセスできる担当者が実施）:
 *   管理 → データストリーム → 対象のウェブストリーム → タグ設定を構成
 *   → 「ドメインの設定」に space-albe.com と booking.space-albe.com の両方を追加。
 *   これで「サイト→予約」を同一ユーザーの行動として計測できる（クロスドメイン）。
 */
(function () {
  'use strict';
  var GA_ID = 'G-XYZM0LL6BB';

  // ── イベント送信ヘルパ（各ページから呼ぶ）──────────────────────
  // gtagが未ロード（localhost等）なら自動的に無処理になる安全設計。
  window.albeTrack = function (name, params) {
    try { if (typeof window.gtag === 'function') window.gtag('event', name, params || {}); } catch (e) {}
  };
  // 二重送信防止つき。key（予約番号・セッションID等の一意値）ごとに1回だけ送る。
  window.albeTrackOnce = function (key, name, params) {
    try {
      var k = 'albe_ev_' + key;
      if (sessionStorage.getItem(k)) return;
      sessionStorage.setItem(k, '1');
    } catch (e) {}
    window.albeTrack(name, params);
  };
  // 予約完了（purchase）を送る共通関数。金額・予約番号つき。
  window.albePurchase = function (o) {
    if (!o) return;
    var id = o.transactionId || o.bookingNumber || '';
    if (!id) return;
    window.albeTrackOnce('pur_' + id, 'purchase', {
      transaction_id: id,
      value: Number(o.value) || 0,
      currency: 'JPY',
      items: [{
        item_id: o.itemId || 'item',
        item_name: o.itemName || '予約',
        item_category: o.category || 'booking',
        price: Number(o.value) || 0,
        quantity: 1,
      }],
    });
  };

  // ローカル開発・プレビューは計測しない（ヘルパは定義済みなので呼んでも無害）
  var h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '' || h.endsWith('.local')) return;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(s);

  gtag('js', new Date());
  // クロスドメイン計測：同一プロパティで両ドメインをリンク（GA4管理画面のドメイン登録と併用）
  gtag('config', GA_ID, { linker: { domains: ['space-albe.com', 'booking.space-albe.com'] } });
})();
