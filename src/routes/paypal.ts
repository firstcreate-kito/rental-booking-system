import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { paypalConfigured, capturePaypalOrder } from '../lib/paypal';
import {
  getBookingPaymentBySession,
  markBookingPaymentPaid,
  getBookingSummaryForGroup,
  createDocumentForGroup,
  getBookingGroupById,
  failBookingGroup,
} from '../db/repository';
import { syncBookingCalendarEvents } from '../lib/gcal-sync';
import { finalizeImmediateBooking, isGroupSlotFree } from '../lib/finalize';
import { notifyBookingEstablished, notifyBookingFailed } from '../lib/notify';
import { nowJST } from '../lib/clock';

const app = new Hono<AppBindings>();

/**
 * POST /api/paypal/capture  body:{orderId}
 * PayPal承認後の戻りページから呼ばれ、注文をキャプチャ（代金確定）して予約を成立させる（#35/#68）。
 * 決済先行（#68）：pending の予約は capture の前に空きを再確認し、埋まっていれば
 *   capture せずに不成立（課金なし）。capture 後に稀な競合が判明した場合は手動返金を管理者へ依頼。
 */
app.post('/capture', async (c) => {
  if (!paypalConfigured(c.env)) return c.json({ error: 'paypal not configured' }, 503);
  const body = await c.req.json().catch(() => ({}));
  const orderId = String((body as Record<string, unknown>).orderId ?? '').trim();
  if (!orderId) return c.json({ error: 'orderId は必須です' }, 400);

  const pay = await getBookingPaymentBySession(c.env.DB, orderId);
  if (!pay) return c.json({ error: '該当する決済が見つかりません' }, 404);

  // 冪等：既にキャプチャ済みならそのまま完了を返す
  if (pay.status === 'paid') {
    const booking = await getBookingSummaryForGroup(c.env.DB, pay.group_id);
    return c.json({ status: 'paid', booking });
  }

  const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  const group = await getBookingGroupById(c.env.DB, pay.group_id);
  const paymentFirst = !!group && group.status === 'pending';

  // 決済先行：capture 前に空きを再確認。埋まっていれば課金せず不成立。
  if (paymentFirst && !(await isGroupSlotFree(c.env, pay.group_id))) {
    await failBookingGroup(c.env.DB, pay.group_id);
    // PayPalは未キャプチャ＝課金なし（refundOk=true 相当・管理者対応不要）
    c.executionCtx.waitUntil(notifyBookingFailed(c.env, pay.group_id, true).catch(() => {}));
    return c.json({ status: 'failed', reason: 'slot_taken' });
  }

  try {
    const cap = await capturePaypalOrder(c.env, orderId);
    if (!cap.completed) return c.json({ status: cap.status.toLowerCase() });

    // 返金用にキャプチャIDを保存する
    await markBookingPaymentPaid(c.env.DB, orderId, nowJST(), { captureId: cap.captureId || null });

    if (paymentFirst) {
      // capture 後に確定（再チェック＋昇格＋カレンダー書き込み）
      const outcome = await finalizeImmediateBooking(c.env, pay.group_id, origin);
      if (outcome !== 'confirmed' && outcome !== 'already') {
        // 稀：capture 後に枠が埋まった → 不成立（PayPalは手動返金が必要なので管理者へ）
        await failBookingGroup(c.env.DB, pay.group_id);
        c.executionCtx.waitUntil(notifyBookingFailed(c.env, pay.group_id, false).catch(() => {}));
        return c.json({ status: 'failed', reason: 'slot_taken_after_capture' });
      }
    } else {
      // 従来（既に confirmed）：カレンダーの支払いステータスを更新
      c.executionCtx.waitUntil(syncBookingCalendarEvents(c.env, pay.group_id, origin).catch(() => {}));
    }

    // 領収書を自動発行（#41・冪等）
    try {
      await createDocumentForGroup(c.env.DB, pay.group_id, 'receipt');
    } catch {
      /* 書類発行失敗は決済処理に影響させない */
    }
    // 決済先行の成立時は、ここで予約確認メール（送信時には送っていない）
    if (paymentFirst) c.executionCtx.waitUntil(notifyBookingEstablished(c.env, pay.group_id).catch(() => {}));

    const booking = await getBookingSummaryForGroup(c.env.DB, pay.group_id);
    return c.json({ status: 'paid', booking });
  } catch (err) {
    return c.json({ error: '決済の確定に失敗しました：' + (err as Error).message }, 502);
  }
});

export default app;
