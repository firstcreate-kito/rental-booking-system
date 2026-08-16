import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  getBookingContactByNumber,
  getBookingSummaryForGroup,
  getSpaceById,
  createChangeRequest,
  hitRateLimit,
  type ChangeRequestType,
} from '../db/repository';
import { guestContactMatches, normalizeEmail } from '../lib/verify';
import { sendEmail, changeRequestReceivedEmail, adminChangeRequestEmail } from '../lib/email';
import { adminRecipients } from '../lib/notify';
import { nowJST } from '../lib/clock';

const app = new Hono<AppBindings>();

const RL_MAX = 12; // 10分あたりの試行上限（IP単位）
const RL_WINDOW_MS = 10 * 60 * 1000;
const GENERIC_FAIL = 'ご予約が確認できませんでした。メールアドレス・電話番号・予約番号をご確認ください。';

function clientIp(c: import('hono').Context<AppBindings>): string {
  return c.req.header('CF-Connecting-IP') || (c.req.header('X-Forwarded-For') || '').split(',')[0].trim() || 'noip';
}

async function rateLimited(c: import('hono').Context<AppBindings>): Promise<boolean> {
  const r = await hitRateLimit(c.env.DB, 'gc:' + clientIp(c), RL_MAX, RL_WINDOW_MS, Date.now());
  return !r.allowed;
}

interface Body {
  bookingNumber?: string;
  email?: string;
  phone?: string;
  type?: string;
  message?: string;
  proposedItems?: Array<{ date?: string; startTime?: string; endTime?: string }>;
}

/** 3点照合して連絡先レコードを返す（不一致は null）。呼び出し側でレート制限済み前提。 */
async function verify(c: import('hono').Context<AppBindings>, b: Body) {
  const number = String(b.bookingNumber ?? '').trim();
  const email = String(b.email ?? '');
  const phone = String(b.phone ?? '');
  if (!number || !email || !phone) return null;
  const contact = await getBookingContactByNumber(c.env.DB, number);
  if (!contact) return null;
  if (!guestContactMatches({ email, phone }, contact)) return null;
  return contact;
}

/**
 * POST /api/guest-change/lookup  {bookingNumber, email, phone}
 * 3点照合に成功したら予約内容を返す（照合前は一切返さない・不一致は理由を明かさない）。
 */
app.post('/lookup', async (c) => {
  if (await rateLimited(c)) return c.json({ error: 'しばらく時間をおいて再度お試しください。' }, 429);
  const b = (await c.req.json().catch(() => ({}))) as Body;
  const contact = await verify(c, b);
  if (!contact) return c.json({ matched: false, error: GENERIC_FAIL }, 200);

  const summary = await getBookingSummaryForGroup(c.env.DB, contact.group_id);
  return c.json({
    matched: true,
    cancelled: contact.status === 'cancelled',
    isMember: !!contact.is_registered,
    booking: summary
      ? { bookingNumber: summary.bookingNumber, spaceName: summary.spaceName, eventName: summary.eventName, status: contact.status, items: summary.items }
      : null,
    // 会員登録誘導のプリフィル用（照合済みなので本人にのみ返す）
    prefill: { email: normalizeEmail(b.email), name: contact.contact_name ?? '', phone: String(b.phone ?? '').trim() },
  });
});

/**
 * POST /api/guest-change/request  {bookingNumber, email, phone, type, message, proposedItems}
 * 送信時に再度3点照合し、変更リクエストを作成（会員と同じ承認ワークフローに合流）。
 */
app.post('/request', async (c) => {
  if (await rateLimited(c)) return c.json({ error: 'しばらく時間をおいて再度お試しください。' }, 429);
  const b = (await c.req.json().catch(() => ({}))) as Body;
  const validTypes: ChangeRequestType[] = ['reschedule', 'option', 'cancel', 'other'];
  if (!b.type || !validTypes.includes(b.type as ChangeRequestType)) {
    return c.json({ error: 'ご希望の種別を選択してください。' }, 400);
  }
  const type = b.type as ChangeRequestType;
  const message = String(b.message ?? '').trim();
  if (!message && type !== 'cancel') return c.json({ error: 'ご希望・ご連絡事項を入力してください。' }, 400);

  const contact = await verify(c, b);
  if (!contact) return c.json({ error: GENERIC_FAIL }, 200);
  if (contact.status === 'cancelled') return c.json({ error: 'キャンセル済みの予約です。' }, 400);

  // 希望日時（reschedule のみ）
  let proposed: Array<{ date: string; startTime: string; endTime: string }> | null = null;
  if (type === 'reschedule' && Array.isArray(b.proposedItems)) {
    const cleaned = b.proposedItems
      .filter((i) => i && i.date && i.startTime && i.endTime)
      .map((i) => ({ date: String(i.date), startTime: String(i.startTime), endTime: String(i.endTime) }));
    if (cleaned.length) proposed = cleaned;
  }

  const space = await getSpaceById(c.env.DB, contact.space_id);
  const spaceName = space?.name ?? '';
  const email = normalizeEmail(b.email);
  const now = nowJST();
  await createChangeRequest(
    c.env.DB,
    { groupId: contact.group_id, customerId: contact.customer_id, bookingNumber: String(b.bookingNumber).trim(), type, message: message || '（キャンセル希望）', contact: email, proposedItems: proposed },
    now,
  );

  // お客様へ受付確認、管理者へ通知（会員フローと同じ）
  if (email) {
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        to: email,
        ...changeRequestReceivedEmail({ customerName: contact.contact_name || 'お客様', bookingNumber: String(b.bookingNumber).trim(), spaceName, type, message, proposedDays: proposed ?? undefined }),
      }),
    );
  }
  const admins = await adminRecipients(c.env, contact.space_id);
  if (admins.length) {
    const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        to: admins,
        ...adminChangeRequestEmail({
          bookingNumber: String(b.bookingNumber).trim(),
          spaceName,
          eventName: contact.event_name,
          type,
          message: message || '（キャンセル希望）',
          customerName: contact.contact_name || 'お客様',
          customerEmail: email,
          proposedDays: proposed ?? undefined,
          adminUrl: `${origin}/admin.html`,
        }),
      }),
    );
  }
  return c.json({ ok: true, message: '変更リクエストを受け付けました。担当者よりご連絡します。' }, 201);
});

export default app;
