import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppBindings } from './types';
import spaces from './routes/spaces';
import bookings from './routes/bookings';
import auth from './routes/auth';
import mypage from './routes/mypage';
import signage from './routes/signage';
import admin from './routes/admin';
import tickets from './routes/tickets';
import webhooks from './routes/webhooks';
import paypal from './routes/paypal';
import documents from './routes/documents';
import { availabilityApi, availabilityPage, sitemapXml } from './routes/availability';
import guestChange from './routes/guest-change';
import viewing from './routes/viewing';
import contact from './routes/contact';
import { embedCalendar } from './routes/embed';
import { BOOKING_CHANGE_HTML } from './lib/booking-change-page';
import {
  getOverdueUnpaidBookings,
  markUnpaidAlertSent,
  getBookingsMissingCalendarEvent,
  getBookingsForUseDateReminder,
  getBookingsForThanks,
  getBookingsForUnpaidCustomerReminder,
  getGroupDays,
  markGroupEmailFlag,
  getSystemSettings,
  getBookingsForPointAward,
  awardBookingPoints,
  getPointBalance,
  getPointHoldersWithActivity,
  expireCustomerPoints,
  markPointExpiryNotified,
  setSystemSetting,
} from './db/repository';
import { pointsForAmount, pointExpiryStatus } from './lib/points';
import {
  unpaidAlertEmail,
  sendEmail,
  bookingReminderEmail,
  thankYouEmail,
  pointExpiryNoticeEmail,
  unpaidCustomerReminderEmail,
  type OverdueBooking,
} from './lib/email';
import { reconcileMissingCalendarEvents } from './lib/gcal-sync';
import { runDataRetention } from './lib/retention';
import { runReleaseExpiredKonbiniHolds } from './lib/konbini-cleanup';
import { runWeeklyReport } from './lib/weekly-report';
import { todayJST, nowJST, addDaysJST } from './lib/clock';

const app = new Hono<AppBindings>();

app.use('*', logger());

/** ゲート通過印（Cookie）の値。認証情報から一意に導出（漏洩しても資格情報は復元不可）。 */
async function gateToken(user: string, pass: string): Promise<string> {
  const data = new TextEncoder().encode(`albe-gate:${user}:${pass}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ベーシック認証（開発中の公開ゲート）。
 * BASIC_AUTH_USER と BASIC_AUTH_PASS の両方が設定されているときだけ有効。
 * 未設定なら素通り（ローカル開発や一般公開時はゲートなし）。
 *
 * 一度パスワードを通すと通過印の Cookie を発行し、以降は Cookie で判定する。
 * これにより、アプリの Authorization: Bearer（会員/管理者ログイン）と
 * ベーシック認証の Authorization: Basic が衝突しなくなる。
 * ※認証情報は ASCII で設定してください。
 */
app.use('*', async (c, next) => {
  const user = c.env.BASIC_AUTH_USER;
  const pass = c.env.BASIC_AUTH_PASS;
  if (!user || !pass) return next();

  // Stripe など外部サービスからの Webhook は Basic 認証を通せないため除外する
  if (c.req.path.startsWith('/api/webhooks/')) return next();
  // 書類（請求書・領収書）は公開トークンURLで閲覧するため除外（トークンが秘匿値）
  if (c.req.path.startsWith('/api/documents/')) return next();
  // 共有デザインアセット（トークン・共通ヘッダーCSS・ロゴ等・非機密）は認証ゲートを通さない
  if (c.req.path.startsWith('/assets/')) return next();
  // PWA関連ファイル（Service Worker・マニフェスト・オフライン表示）は非機密。
  // Service Worker はルート(/)スコープで配信する必要があるため /assets/ には置けない。
  if (c.req.path === '/sw.js' || c.req.path === '/manifest.webmanifest' || c.req.path === '/offline.html') return next();
  // 空き状況ページ（公開・SEO対象）とその取得API・sitemap は認証ゲートを通さない（#74）
  if (c.req.path === '/availability' || c.req.path.startsWith('/availability/')) return next();
  if (c.req.path.startsWith('/api/availability')) return next();
  if (c.req.path === '/sitemap.xml') return next();
  // ゲスト予約変更ページ（公開・#75）とそのAPIも認証ゲートを通さない
  if (c.req.path === '/booking-change' || c.req.path.startsWith('/booking-change/') || c.req.path === '/booking-change.html') return next();
  if (c.req.path.startsWith('/api/guest-change')) return next();
  // 見学申込ページ（公開・#81）とそのAPIも認証ゲートを通さない
  if (c.req.path === '/viewing' || c.req.path.startsWith('/viewing/') || c.req.path === '/viewing.html') return next();
  if (c.req.path.startsWith('/api/viewing')) return next();
  // 公式サイトのお問い合わせフォーム（公開・別ドメインから POST）も認証ゲートを通さない
  if (c.req.path.startsWith('/api/contact')) return next();
  // スペース一覧・料金・空き取得API（公開・読み取り専用。公式サイトの料金/施設一覧・
  // お問い合わせフォームの施設セレクト生成に使用）。GETのみ・toPublicSpace の公開射影。
  if (c.req.path.startsWith('/api/spaces')) return next();
  // 英語ご予約ガイド（公開・#80 多言語化）。海外のお客様・公式サイトからのリンク先。
  if (c.req.path === '/en' || c.req.path === '/en.html') return next();

  const expected = await gateToken(user, pass);

  // 既に通過済み（Cookie）なら Authorization ヘッダに依存せず通す
  const cookie = c.req.header('Cookie') ?? '';
  const passed = cookie.split(';').some((kv) => kv.trim() === `albe_gate=${expected}`);
  if (passed) return next();

  // Basic 認証の検証
  const header = c.req.header('Authorization');
  if (header?.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = '';
    }
    const idx = decoded.indexOf(':');
    if (idx >= 0 && decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass) {
      await next();
      // 通過印の Cookie を付与（ASSETS 応答は不変なので作り直して設定）
      const res = new Response(c.res.body, c.res);
      res.headers.append(
        'Set-Cookie',
        `albe_gate=${expected}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
      );
      c.res = res;
      return;
    }
  }
  return new Response('認証が必要です。', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="ALBE (development)", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
});

app.use('/api/*', cors());

/** ヘルスチェック（JSON） */
app.get('/api/health', (c) => {
  return c.json({
    service: 'albe-booking-api',
    status: 'ok',
    env: c.env.APP_ENV ?? 'unknown',
  });
});

/** DB接続確認用（開発時のみ想定） */
app.get('/api/health/db', async (c) => {
  try {
    const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM spaces').first<{ n: number }>();
    return c.json({ ok: true, spaces: row?.n ?? 0 });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// API ルート
app.route('/api/spaces', spaces);
app.route('/api/bookings', bookings);
app.route('/api/auth', auth);
app.route('/api/mypage', mypage);
app.route('/api/signage', signage);
app.route('/api/admin', admin);
app.route('/api/tickets', tickets);
app.route('/api/webhooks', webhooks);
app.route('/api/paypal', paypal);
app.route('/api/documents', documents);
app.route('/api/availability', availabilityApi);
app.route('/api/guest-change', guestChange);
app.route('/api/viewing', viewing);
app.route('/api/contact', contact);

// 空き状況ページ（SSR）と sitemap（静的アセットより先に登録）#74
app.get('/availability', availabilityPage);
app.get('/availability/', availabilityPage);
app.get('/sitemap.xml', sitemapXml);

// 施設単位の月間カレンダー埋め込み（#19・外部サイトに iframe で貼る）。静的アセットより先に登録。
app.get('/embed/calendar', embedCalendar);
app.get('/embed/calendar/', embedCalendar);

// ゲスト予約の変更ページ（公開・#75）。Workerが直接HTMLを返す（両スラッシュとも200）。
const serveBookingChange = (c: import('hono').Context<AppBindings>) => c.html(BOOKING_CHANGE_HTML);
app.get('/booking-change', serveBookingChange);
app.get('/booking-change/', serveBookingChange);
// 見学申込ページ（公開・#81）は public/viewing.html を静的アセットとして配信する。
// /viewing は catch-all（app.all('*')→ASSETS）が /viewing.html を返す（/mypage 等と同じ挙動）。

/**
 * 静的アセット（public/）を Worker 経由で配信する。
 * ベーシック認証を静的ファイルにも効かせるため、assets を Worker より先に
 * 配信せず（run_worker_first）、ここで ASSETS バインディングに委譲する。
 */
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

/** 予約確定からこの日数を過ぎても未入金ならアラート（#41/#42） */
const UNPAID_ALERT_DAYS = 7;

/**
 * 定期実行（Cron）: 未入金アラート。
 * 予約確定から UNPAID_ALERT_DAYS 日以上経過しても入金されていない予約を検知し、
 * 管理者（rental@space-albe.com など）へ1予約1回だけアラートメールを送る。
 */
async function runUnpaidAlert(env: AppBindings['Bindings']): Promise<{ count: number }> {
  const cutoff = addDaysJST(todayJST(), -UNPAID_ALERT_DAYS);
  const overdue = await getOverdueUnpaidBookings(env.DB, cutoff);
  if (!overdue.length) return { count: 0 };

  const bookings: OverdueBooking[] = overdue.map((b) => ({
    bookingNumber: b.booking_number,
    spaceName: b.space_name ?? '',
    total: b.total_amount,
    createdAt: b.created_at,
    paymentMethod: b.payment_method,
    recipientName: (b.invoice_name || b.contact_name || 'お客様').trim(),
    customerEmail: b.email,
  }));
  const to = env.MAIL_ADMIN || 'rental@space-albe.com';
  const mail = unpaidAlertEmail({ days: UNPAID_ALERT_DAYS, bookings });
  await sendEmail(env, { to, ...mail });
  await markUnpaidAlertSent(
    env.DB,
    overdue.map((b) => b.id),
    nowJST(),
  );
  return { count: overdue.length };
}

/**
 * 定期実行（Cron）: Googleカレンダー取りこぼし補完（#25/#27）。
 * 書き込み失敗で google_event_id が未設定の予約を検出し、GCalへ再作成する。
 * これで「D1にはあるがGCalに無い」状態が解消され、外部からの二重予約を防ぐ。
 */
async function runCalendarReconcile(env: AppBindings['Bindings']): Promise<{ created: number; failed: number }> {
  const rows = await getBookingsMissingCalendarEvent(env.DB, todayJST());
  const result = await reconcileMissingCalendarEvents(env, rows);
  // 空き状況ページの「最終更新」表示用に、同期実行時刻を記録（#74）
  await setSystemSetting(env.DB, 'gcal_last_sync_at', nowJST()).catch(() => {});
  return result;
}

/** 受注からこの日数を過ぎても未入金なら、お客様へリマインド（#50） */
const UNPAID_CUSTOMER_REMINDER_DAYS = 3;

/** 定期メール：利用前リマインダー（3日前・1日前）#45 */
async function runUseDateReminders(env: AppBindings['Bindings']): Promise<void> {
  const today = todayJST();
  const jobs: Array<[3 | 1, 'reminder_3d_sent_at' | 'reminder_1d_sent_at']> = [
    [3, 'reminder_3d_sent_at'],
    [1, 'reminder_1d_sent_at'],
  ];
  for (const [days, col] of jobs) {
    const rows = await getBookingsForUseDateReminder(env.DB, col, addDaysJST(today, days));
    const sent: string[] = [];
    for (const r of rows) {
      const dayList = await getGroupDays(env.DB, r.id);
      await sendEmail(env, {
        to: r.email,
        ...bookingReminderEmail({
          customerName: r.contact_name || 'お客様',
          bookingNumber: r.booking_number,
          spaceName: r.space_name || '',
          eventName: r.event_name,
          days: dayList,
          daysBefore: days,
          changeUrl: (env.PUBLIC_BASE_URL || '') ? `${env.PUBLIC_BASE_URL}/booking-change/?num=${encodeURIComponent(r.booking_number)}` : undefined,
          spaceNote: r.email_note ?? undefined,
        }),
      });
      sent.push(r.id);
    }
    await markGroupEmailFlag(env.DB, col, sent, nowJST());
  }
}

/** 定期メール：利用後のお礼（利用終了の翌日）#53 */
async function runThanks(env: AppBindings['Bindings']): Promise<void> {
  const origin = env.PUBLIC_BASE_URL || '';
  // ポイント案内用に還元率を取得（会員・入金済みのみ「今回○P付与」を案内）#70
  const settings = await getSystemSettings(env.DB);
  const rate = Number(settings.get('point_rate') ?? '1');
  const rows = await getBookingsForThanks(env.DB, addDaysJST(todayJST(), -1));
  const sent: string[] = [];
  for (const r of rows) {
    const eligible = r.is_registered === 1 && r.payment_status === 'paid' && rate > 0;
    const earned = eligible ? pointsForAmount(r.total_amount, rate) : 0;
    // 残高はポイント付与処理（runPointAward）実行後の値。今回付与ぶんも反映済み。
    const balance = earned > 0 ? await getPointBalance(env.DB, r.customer_id) : undefined;
    await sendEmail(env, {
      to: r.email,
      ...thankYouEmail({
        customerName: r.contact_name || 'お客様',
        spaceName: r.space_name || '',
        bookingUrl: origin ? origin + '/' : undefined,
        pointsEarned: earned > 0 ? earned : undefined,
        pointBalance: balance,
      }),
    });
    sent.push(r.id);
  }
  await markGroupEmailFlag(env.DB, 'thanks_sent_at', sent, nowJST());
}

/** 定期処理：利用完了ポイントの付与（#70）。利用日翌日以降・確定・入金済み・会員に 1%（既定）を付与。 */
async function runPointAward(env: AppBindings['Bindings']): Promise<void> {
  const settings = await getSystemSettings(env.DB);
  const rate = Number(settings.get('point_rate') ?? '1');
  if (!(rate > 0)) return; // 還元率0なら付与しない
  const cutoff = addDaysJST(todayJST(), -1); // 利用日が昨日以前＝利用完了
  const rows = await getBookingsForPointAward(env.DB, cutoff);
  let awarded = 0;
  for (const r of rows) {
    const pts = pointsForAmount(r.total_amount, rate);
    await awardBookingPoints(env.DB, r.id, r.customer_id, pts, nowJST());
    if (pts > 0) awarded++;
  }
  console.log(`[points] rate=${rate}% targets=${rows.length} awarded=${awarded}`);
}

/**
 * 定期処理：ポイントの失効と期限接近メール（#78）。
 * 最終活動（獲得または利用）から1年（POINT_EXPIRY_DAYS）でローリング失効。
 * 期限の30日前以内の会員には1回だけお知らせを送る（延長で期限が動けば再通知）。
 */
async function runPointExpiry(env: AppBindings['Bindings']): Promise<void> {
  const origin = env.PUBLIC_BASE_URL || '';
  const today = todayJST();
  const holders = await getPointHoldersWithActivity(env.DB);
  let expired = 0;
  let notified = 0;
  for (const h of holders) {
    if (!h.last_at) continue; // 活動履歴が無ければ判定不能（安全側でスキップ）
    const lastDate = h.last_at.slice(0, 10); // 'YYYY-MM-DD'（T/空白どちらの区切りでも可）
    const { expiryDate, action } = pointExpiryStatus(lastDate, today);
    if (action === 'expire') {
      await expireCustomerPoints(env.DB, h.id, h.point_balance, nowJST());
      expired++;
      continue;
    }
    // 期限接近 → 会員へお知らせ（同じ期限日には1回だけ）
    if (action === 'notice' && h.email && h.points_expiry_notified_on !== expiryDate) {
      await sendEmail(env, {
        to: h.email,
        ...pointExpiryNoticeEmail({
          customerName: h.contact_name || 'お客様',
          pointBalance: h.point_balance,
          expiryDate,
          bookingUrl: origin ? origin + '/' : undefined,
        }),
      });
      await markPointExpiryNotified(env.DB, h.id, expiryDate);
      notified++;
    }
  }
  console.log(`[point-expiry] holders=${holders.length} expired=${expired} notified=${notified}`);
}

/** 定期メール：顧客向け未入金リマインダー（#50） */
async function runUnpaidCustomerReminder(env: AppBindings['Bindings']): Promise<void> {
  const cutoff = addDaysJST(todayJST(), -UNPAID_CUSTOMER_REMINDER_DAYS);
  const rows = await getBookingsForUnpaidCustomerReminder(env.DB, cutoff);
  const sent: string[] = [];
  for (const r of rows) {
    const dayList = await getGroupDays(env.DB, r.id);
    await sendEmail(env, {
      to: r.email,
      ...unpaidCustomerReminderEmail({
        customerName: r.contact_name || 'お客様',
        bookingNumber: r.booking_number,
        spaceName: r.space_name || '',
        total: r.total_amount,
        days: dayList,
      }),
    });
    sent.push(r.id);
  }
  await markGroupEmailFlag(env.DB, 'unpaid_reminder_sent_at', sent, nowJST());
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: AppBindings['Bindings'], ctx: ExecutionContext): Promise<void> {
    // GCal取りこぼし補完は毎回（5分間隔）実行。それ以外は1日1回（0:00 UTC=9:00 JST）。
    ctx.waitUntil(runCalendarReconcile(env));
    if (event.cron === '0 0 * * *') {
      ctx.waitUntil(runUnpaidAlert(env));
      // コンビニ仮押さえの期限切れ解放（#39・Webhook不達時の安全網）
      ctx.waitUntil(runReleaseExpiredKonbiniHolds(env).then(() => {}).catch(() => {}));
      ctx.waitUntil(runUseDateReminders(env).catch(() => {}));
      ctx.waitUntil(runUnpaidCustomerReminder(env).catch(() => {}));
      // 利用完了ポイントの付与（#70）→ その後にお礼メール（今回付与ぶんを残高に反映して案内）
      ctx.waitUntil(
        (async () => {
          await runPointAward(env).catch(() => {});
          await runThanks(env).catch(() => {});
          // ポイント失効・期限接近メール（#78）。付与後に判定して当日の付与ぶんを反映。
          await runPointExpiry(env).catch(() => {});
        })(),
      );
      // データ保持ポリシー（#57）: 7年経過した顧客の個人情報を匿名化（既定はドライラン）
      ctx.waitUntil(runDataRetention(env).then(() => {}).catch(() => {}));
    }
    // 週次「翌週の予約」まとめメール（#111）: 毎週月曜 00:00 UTC＝09:00 JST。
    // スペース単位でその週（月〜日）の予約一覧をオーナー宛に送る。
    if (event.cron === '0 0 * * 1') {
      ctx.waitUntil(runWeeklyReport(env).then(() => {}).catch(() => {}));
    }
  },
};
