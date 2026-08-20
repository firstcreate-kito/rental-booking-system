/**
 * 見学申込（#81）— 公開API。
 * - GET  /api/viewing/slots?spaces=a,b&date=YYYY-MM-DD  … 選択施設が共通で見学できる開始時刻
 * - POST /api/viewing/requests                          … 見学申込の受付（申請制）
 *
 * 空き＝本予約(confirmed)・商談中(tentative)・ブロック・仮確保のいずれも入っていない枠。
 * 複数施設は「全施設が同じ枠で空いている」共通枠のみ。所要30分固定。
 * Googleカレンダーには反映しない（記録のみ）。読み取りはD1（約5分同期）を使用。
 */
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  getSpaceById,
  getSpaceBookingsOnDate,
  getHolidays,
  getSpaceClosures,
  createViewingRequest,
} from '../db/repository';
import { isClosed } from '../lib/calendar';
import { getOptionalCustomer } from '../middleware/auth';
import { todayJST, nowJST, addDaysJST } from '../lib/clock';
import { adminRecipients } from '../lib/notify';
import {
  commonViewingStartTimes,
  VIEWING_DURATION_MIN,
  VIEWING_MAX_AHEAD_DAYS,
  type SpaceDayInput,
} from '../lib/viewing';
import { sendEmail, viewingReceivedEmail, adminViewingRequestEmail } from '../lib/email';
import { isValidEmail } from '../lib/auth';

const app = new Hono<AppBindings>();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const BOOKING_STATUS = new Set(['booked', 'considering', 'other']);

interface ResolvedSpace {
  id: string;
  name: string;
}

/** 選択施設の、指定日の共通見学可能開始時刻を算出（GET/POST共用）。 */
async function computeCommonSlots(
  env: AppBindings['Bindings'],
  spaceIds: string[],
  date: string,
): Promise<
  | { error: string; status: 400 | 404 }
  | { spaces: ResolvedSpace[]; closed: boolean; startTimes: string[]; nowTime: string; today: string }
> {
  const today = todayJST();
  if (!DATE_RE.test(date)) return { error: 'date(YYYY-MM-DD) is required', status: 400 };
  if (date < today) return { error: '過去の日付は指定できません', status: 400 };
  if (date > addDaysJST(today, VIEWING_MAX_AHEAD_DAYS)) {
    return { error: `見学申込は本日から${VIEWING_MAX_AHEAD_DAYS}日先までです`, status: 400 };
  }
  if (spaceIds.length === 0) return { error: 'スペースを1つ以上選択してください', status: 400 };

  const holidays = await getHolidays(env.DB, date, date);
  const inputs: SpaceDayInput[] = [];
  const spaces: ResolvedSpace[] = [];
  for (const id of spaceIds) {
    const s = await getSpaceById(env.DB, id);
    if (!s || !s.is_active) return { error: `スペースが見つかりません（${id}）`, status: 404 };
    spaces.push({ id: s.id, name: s.name });
    const closures = await getSpaceClosures(env.DB, s.id, date, date);
    const closed = isClosed(date, { holidays, spaceClosureDates: closures });
    const bookings = await getSpaceBookingsOnDate(env.DB, s.id, date);
    inputs.push({
      occupying: bookings.map((b) => ({ startTime: b.start_time, endTime: b.end_time, status: b.status })),
      openTime: s.open_time,
      closeTime: s.close_time,
      closed,
    });
  }

  const anyClosed = inputs.some((i) => i.closed);
  let startTimes = anyClosed ? [] : commonViewingStartTimes(inputs, VIEWING_DURATION_MIN);
  // 当日は過去の開始時刻を除外
  const nowTime = nowJST().slice(11, 16);
  if (date === today) startTimes = startTimes.filter((t) => t > nowTime);
  return { spaces, closed: anyClosed, startTimes, nowTime, today };
}

/** GET /api/viewing/slots?spaces=a,b&date=YYYY-MM-DD */
app.get('/slots', async (c) => {
  const spacesParam = (c.req.query('spaces') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const date = c.req.query('date') || '';
  const result = await computeCommonSlots(c.env, spacesParam, date);
  if ('error' in result) return c.json({ error: result.error }, result.status);
  c.header('Cache-Control', 'no-store');
  return c.json({
    date,
    durationMin: VIEWING_DURATION_MIN,
    spaces: result.spaces,
    closed: result.closed,
    startTimes: result.startTimes,
    today: result.today,
    nowTime: result.nowTime,
  });
});

/** POST /api/viewing/requests */
app.post('/requests', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const mode = body.mode === 'propose' ? 'propose' : 'slot';
  const spaceIds = Array.isArray(body.spaces) ? (body.spaces as unknown[]).map(String).filter(Boolean) : [];
  const lastName = String((body.lastName as string) || '').trim();
  const firstName = String((body.firstName as string) || '').trim();
  const contactName = [lastName, firstName].filter(Boolean).join(' ') || String((body.contactName as string) || '').trim();
  const email = String((body.email as string) || '').trim();
  const phone = String((body.phone as string) || '').trim();
  const orgName = String((body.orgName as string) || '').trim() || null;
  const purpose = String((body.purpose as string) || '').trim();
  const bookingStatus = String((body.bookingStatus as string) || '').trim();
  const note = String((body.note as string) || '').trim() || null;

  // 共通バリデーション
  if (spaceIds.length === 0) return c.json({ error: '見学希望のスペースを選択してください' }, 400);
  if (!contactName) return c.json({ error: 'お名前を入力してください' }, 400);
  if (!email || !isValidEmail(email)) return c.json({ error: '有効なメールアドレスを入力してください' }, 400);
  if (!phone) return c.json({ error: '電話番号を入力してください' }, 400);
  if (!purpose) return c.json({ error: '利用目的を選択してください' }, 400);
  if (!BOOKING_STATUS.has(bookingStatus)) return c.json({ error: '現在の予約状況を選択してください' }, 400);

  let first: { date: string; start: string } | null = null;
  let second: { date: string; start: string } | null = null;
  let desiredPeriod: string | null = null;
  let prefDaytype: string | null = null;
  let prefTimeband: string | null = null;
  let spacesResolved: ResolvedSpace[] = [];

  if (mode === 'slot') {
    const parseChoice = (v: unknown): { date: string; start: string } | null => {
      if (!v || typeof v !== 'object') return null;
      const o = v as Record<string, unknown>;
      const date = String(o.date || '');
      const start = String(o.start || '');
      if (!DATE_RE.test(date) || !TIME_RE.test(start)) return null;
      return { date, start };
    };
    first = parseChoice(body.first);
    second = parseChoice(body.second);
    if (!first) return c.json({ error: '第一希望の日時を選択してください' }, 400);
    if (!second) return c.json({ error: '第二希望の日時を選択してください' }, 400);

    // サーバ側でも空きを再判定（送信時点でのD1基準）
    for (const [label, ch] of [['第一希望', first], ['第二希望', second]] as const) {
      const slots = await computeCommonSlots(c.env, spaceIds, ch.date);
      if ('error' in slots) return c.json({ error: `${label}：${slots.error}` }, 422);
      spacesResolved = slots.spaces;
      if (slots.closed || !slots.startTimes.includes(ch.start)) {
        return c.json(
          { error: `${label}（${ch.date} ${ch.start}）は現在ご案内できません。別の空き枠をお選びください。`, mode: 'slot' },
          422,
        );
      }
    }
  } else {
    desiredPeriod = String((body.desiredPeriod as string) || '').trim() || null;
    prefDaytype = String((body.prefDaytype as string) || '').trim() || null;
    prefTimeband = String((body.prefTimeband as string) || '').trim() || null;
    if (!desiredPeriod) return c.json({ error: 'おおよそのご希望時期を入力してください' }, 400);
    // 施設の存在確認と名称取得
    for (const id of spaceIds) {
      const s = await getSpaceById(c.env.DB, id);
      if (!s || !s.is_active) return c.json({ error: `スペースが見つかりません（${id}）` }, 404);
      spacesResolved.push({ id: s.id, name: s.name });
    }
  }

  // ログイン済み会員なら申込に会員IDを紐づける（任意・ゲスト申込も可）
  const member = await getOptionalCustomer(c);

  const id = crypto.randomUUID();
  const now = nowJST();
  await createViewingRequest(c.env.DB, {
    id,
    mode,
    customerName: contactName,
    email,
    phone,
    orgName,
    purpose,
    bookingStatus,
    firstDate: first?.date ?? null,
    firstStart: first?.start ?? null,
    secondDate: second?.date ?? null,
    secondStart: second?.start ?? null,
    desiredPeriod,
    prefDaytype,
    prefTimeband,
    note,
    customerId: member?.id ?? null,
    spaceIds,
    now,
  });

  // メール（お客様受付＋スタッフ通知）。失敗しても受付は成立させる。
  const spaceNames = spacesResolved.map((s) => s.name).join(' / ');
  const choices =
    mode === 'slot' && first && second
      ? [
          { label: '第一希望', date: first.date, start: first.start },
          { label: '第二希望', date: second.date, start: second.start },
        ]
      : undefined;
  const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: email,
      ...viewingReceivedEmail({ customerName: contactName, spaceNames, mode, choices, desiredPeriod: desiredPeriod ?? undefined, purpose, note: note ?? undefined }),
    }),
  );
  // スタッフ宛：全選択施設の通知先を集約
  const recipientSet = new Set<string>();
  for (const s of spacesResolved) {
    const rs = await adminRecipients(c.env, s.id);
    rs.forEach((r) => recipientSet.add(r));
  }
  const admins = [...recipientSet];
  if (admins.length > 0) {
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        to: admins,
        ...adminViewingRequestEmail({
          customerName: contactName,
          spaceNames,
          mode,
          choices,
          desiredPeriod: desiredPeriod ?? undefined,
          purpose,
          note: note ?? undefined,
          email,
          phone,
          orgName: orgName ?? undefined,
          bookingStatus,
          adminUrl: `${origin}/admin.html`,
        }),
      }),
    );
  }

  return c.json({ ok: true, id }, 201);
});

export default app;
