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

  // ローカル開発・プレビューは計測しない
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
