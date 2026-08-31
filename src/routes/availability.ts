import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { assembleAvailability } from '../lib/availability-service';
import { renderAvailabilityPage } from '../lib/availability-page';
import { getSystemSetting } from '../db/repository';
import { todayJST, addDaysJST } from '../lib/clock';

const LINE_URL = 'https://lin.ee/46iS2Iu';

function isYmd(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** ymd の曜日(0=日..6=土) */
function dow(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
/** 今日以降の直近の土曜（今日が土曜なら今日） */
function nextWeekend(today: string): string {
  let d = today;
  for (let i = 0; i < 7; i++) {
    if (dow(d) === 6) return d;
    d = addDaysJST(d, 1);
  }
  return today;
}

/** JSON API: GET /api/availability?date=&use=&area= */
export const availabilityApi = new Hono<AppBindings>();
availabilityApi.get('/', async (c) => {
  const q = c.req.query('date');
  const date = isYmd(q) ? q : todayJST();
  const data = await assembleAvailability(c.env, date, { use: c.req.query('use'), area: c.req.query('area') });
  c.header('Cache-Control', 'public, max-age=300'); // 同期間隔と同じ5分
  return c.json(data);
});

/** 埋め込み表示を一時停止しているときに iframe 内へ返す「準備中」ページ。 */
function embedDisabledHtml(): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>準備中</title></head>
<body style="margin:0;font-family:system-ui,sans-serif;background:transparent;color:#64748b">
<div style="padding:40px 20px;text-align:center;font-size:15px;line-height:1.8">ただいま準備中です。</div>
</body></html>`;
}

/** SSR ページ: GET /availability(/) */
export async function availabilityPage(c: import('hono').Context<AppBindings>): Promise<Response> {
  const q = c.req.query('date');
  const today = todayJST();
  const date = isYmd(q) ? q : today;
  // 埋め込み（iframe）は管理画面のトグルで一時停止できる。既定は停止（明示的に有効化した時のみ表示）。
  const embed = c.req.query('embed') === '1';
  if (embed) {
    const embedEnabled = (await getSystemSetting(c.env.DB, 'availability_embed_enabled')) === '1';
    if (!embedEnabled) {
      c.header('Cache-Control', 'no-store');
      return c.html(embedDisabledHtml());
    }
  }
  const data = await assembleAvailability(c.env, date, { use: c.req.query('use'), area: c.req.query('area') });
  const contactUrl = (await getSystemSetting(c.env.DB, 'contact_url')) ?? '/';
  const html = renderAvailabilityPage(data, {
    today,
    tomorrow: addDaysJST(today, 1),
    weekend: nextWeekend(today),
    contactUrl,
    lineUrl: LINE_URL,
    loginUrl: '/mypage.html',
    embed, // WEBサイト等への iframe 埋め込み（#19・上のトグルで有効化した時のみ到達）
  });
  c.header('Cache-Control', 'public, max-age=300');
  return c.html(html);
}

/** sitemap.xml（/availability/ を含む） */
export async function sitemapXml(c: import('hono').Context<AppBindings>): Promise<Response> {
  const base = c.env.PUBLIC_BASE_URL || 'https://space-albe.com';
  const urls = ['/', '/availability/'];
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    urls.map((u) => `<url><loc>${base}${u}</loc></url>`).join('') +
    '</urlset>';
  return c.body(body, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
}
