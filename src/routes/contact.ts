/**
 * お問い合わせ（公式サイト space-albe.com/contact/ から送信）— 公開API。
 * - POST /api/contact … JSON を受け取り、担当者宛＋お客様への控えメールを送る。
 *
 * CORS は index.ts の `app.use('/api/*', cors())`（全オリジン許可）でカバー。
 * 認証ゲート（公開前 Basic 認証）も index.ts のallowlistで /api/contact を通す。
 * 見学申込（/api/viewing）と同じ流儀：メール送信は waitUntil で行い、失敗しても 2xx を返す。
 */
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { getSpaceById } from '../db/repository';
import { adminRecipients } from '../lib/notify';
import { sendEmail, contactReceivedEmail, adminContactEmail } from '../lib/email';
import { isValidEmail } from '../lib/auth';

const app = new Hono<AppBindings>();

// ご用件（type）の許可値。未知の値は 'other' に丸める。
const CONTACT_TYPES = new Set(['reserve', 'quote', 'multi', 'long', 'equipment', 'invoice', 'partner', 'other']);

/** POST /api/contact */
app.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const s = (k: string) => String((body[k] as string) ?? '').trim();
  const type = CONTACT_TYPES.has(s('type')) ? s('type') : 'other';
  const spaceId = s('space');
  const date = s('date');
  const days = s('days');
  const name = s('name');
  const company = s('company');
  const mail = s('mail');
  const tel = s('tel');
  const text = s('body');
  const agree = s('agree');
  const lang: 'ja' | 'en' = s('lang') === 'en' ? 'en' : 'ja';
  const page = s('page');
  const en = lang === 'en';

  // 必須：お名前・メール・お問い合わせ内容・同意
  if (!name) return c.json({ error: en ? 'Name is required.' : 'お名前を入力してください。' }, 400);
  if (!mail || !isValidEmail(mail)) return c.json({ error: en ? 'A valid email address is required.' : '有効なメールアドレスを入力してください。' }, 400);
  if (!text) return c.json({ error: en ? 'Message is required.' : 'お問い合わせ内容を入力してください。' }, 400);
  if (agree !== 'on' && agree !== 'true' && agree !== '1' && agree !== 'yes') {
    return c.json({ error: en ? 'Please agree to the privacy policy.' : 'プライバシーポリシーへの同意が必要です。' }, 400);
  }

  // 施設名の解決（IDが実在すれば名称、なければ入力値をそのまま表示）
  let spaceName = '';
  if (spaceId) {
    const sp = await getSpaceById(c.env.DB, spaceId).catch(() => null);
    spaceName = sp?.name ? String(sp.name) : spaceId;
  }

  const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  const payload = { type, spaceId, spaceName, date, days, name, company, mail, tel, body: text, lang, page };

  // お客様への控え（lang=en なら英語）
  c.executionCtx.waitUntil(sendEmail(c.env, { to: mail, ...contactReceivedEmail(payload) }).catch(() => {}));

  // 担当者宛（施設が特定できれば施設別通知先＋本部、なければ本部のみ）
  const admins = await adminRecipients(c.env, spaceId || undefined);
  if (admins.length > 0) {
    c.executionCtx.waitUntil(
      sendEmail(c.env, { to: admins, ...adminContactEmail({ ...payload, adminUrl: `${origin}/admin.html` }) }).catch(() => {}),
    );
  }

  return c.json({ ok: true }, 201);
});

export default app;
