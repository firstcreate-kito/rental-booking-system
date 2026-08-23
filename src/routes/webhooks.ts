import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { verifyStripeWebhook, stripeConfigured, refundPayment } from '../lib/stripe';
import { fulfillTicketPurchase, getBookingPaymentBySession, markBookingPaymentPaid, createDocumentForGroup, reissueReceiptForGroup, recordBookingEvent, getBookingSummaryForGroup, getCustomerProfile, getBookingGroupById, failBookingGroup } from '../db/repository';
import { sendEmail, ticketPurchaseEmail } from '../lib/email';
import { notifyPaymentConfirmed, notifyBookingEstablished, notifyBookingFailed } from '../lib/notify';
import { finalizeImmediateBooking } from '../lib/finalize';
import { syncBookingCalendarEvents } from '../lib/gcal-sync';
import { nowJST, todayJST, addDaysJST } from '../lib/clock';

const app = new Hono<AppBindings>();

/**
 * POST /api/webhooks/stripe
 * Stripe からの決済完了通知。署名検証に成功し、checkout.session.completed のとき
 * 対象商品のチケットを顧客へ発行する（冪等）。
 * ※ Basic 認証ゲートは index.ts で /api/webhooks/* を除外している。
 */
app.post('/stripe', async (c) => {
  if (!stripeConfigured(c.env)) return c.json({ error: 'stripe not configured' }, 503);
  const payload = await c.req.text();
  const sig = c.req.header('Stripe-Signature');

  let event;
  try {
    event = await verifyStripeWebhook(payload, sig, c.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    // 署名不正は 400（Stripe は再送しない）
    return c.json({ error: 'signature verification failed: ' + (err as Error).message }, 400);
  }

  // 即時決済（カード/Apple Pay）は completed、コンビニ払い等の後払いは
  // 実際の入金時に async_payment_succeeded が届く。両方で「入金確定」を処理する。
  const PAID_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (PAID_EVENTS.includes(event.type)) {
    const session = event.data.object as { id?: string; payment_status?: string; payment_intent?: string };
    // payment_status が paid のときのみ処理（コンビニ受付直後(unpaid)は入金待ちのため対象外）
    if (session.id && session.payment_status === 'paid') {
      // 予約のカード決済か、チケット購入かをセッションIDで判別（#35）
      const bookingPay = await getBookingPaymentBySession(c.env.DB, session.id);
      if (bookingPay) {
        const origin = c.env.PUBLIC_BASE_URL || '';
        const piForRefund = typeof session.payment_intent === 'string' ? session.payment_intent : null;

        // 追加請求（差額の後日徴収）の入金：本予約フローとは別扱い。
        // 入金を記録し、領収書を最終金額で再発行する（備考に経緯）。
        if (bookingPay.kind === 'additional') {
          const ar = await markBookingPaymentPaid(c.env.DB, session.id, nowJST(), { paymentIntent: piForRefund });
          if (!ar.ok) return c.json({ received: true, paid: false }, 500);
          try {
            const addYen = '¥' + Number(bookingPay.amount).toLocaleString('ja-JP');
            const remark = `${todayJST()} 予約内容変更に伴う追加分 ${addYen} を反映し、変更後の合計金額で再発行しました。`;
            await reissueReceiptForGroup(c.env.DB, ar.groupId!, remark);
            await recordBookingEvent(c.env.DB, { groupId: ar.groupId!, type: 'additional_paid', amount: bookingPay.amount, summary: `追加分 ${addYen} のお支払いを確認`, actor: 'system' }, nowJST());
          } catch {
            /* 領収書再発行・履歴記録の失敗は決済処理に影響させない */
          }
          return c.json({ received: true, paid: true, additional: true, groupId: ar.groupId });
        }

        const group = await getBookingGroupById(c.env.DB, bookingPay.group_id);
        // 課金は成立しているので、まず入金を記録する（返金用に payment_intent も保存）
        const r = await markBookingPaymentPaid(c.env.DB, session.id, nowJST(), { paymentIntent: piForRefund });
        if (!r.ok) return c.json({ received: true, paid: false }, 500);
        const groupId = r.groupId!;

        // 決済先行（#68）：pending は入金時に空きを再確認して成立 or 不成立＋返金
        if (group && group.status === 'pending') {
          const outcome = await finalizeImmediateBooking(c.env, groupId, origin);
          if (outcome === 'confirmed' || outcome === 'already') {
            // 入金確定で領収書を自動発行（#41・冪等）
            try {
              await createDocumentForGroup(c.env.DB, groupId, 'receipt');
            } catch {
              /* 書類発行失敗は決済処理に影響させない */
            }
            c.executionCtx.waitUntil(notifyBookingEstablished(c.env, groupId).catch(() => {}));
            return c.json({ received: true, paid: true, established: true, groupId });
          }
          // 枠が埋まっていた → 自動返金＋不成立
          const piId = typeof session.payment_intent === 'string' ? session.payment_intent : '';
          let refundOk = false;
          if (piId && c.env.STRIPE_SECRET_KEY) {
            refundOk = (await refundPayment(c.env.STRIPE_SECRET_KEY, piId)).ok;
          }
          await failBookingGroup(c.env.DB, groupId);
          c.executionCtx.waitUntil(notifyBookingFailed(c.env, groupId, refundOk).catch(() => {}));
          return c.json({ received: true, paid: true, established: false, refunded: refundOk, groupId });
        }

        // 従来フロー（銀行振込の後払い確定など：既に confirmed）
        let receiptPath: string | null = null;
        try {
          const doc = await createDocumentForGroup(c.env.DB, groupId, 'receipt');
          if (doc) receiptPath = '/api/documents/' + doc.token;
        } catch {
          /* 書類発行失敗は決済処理に影響させない */
        }
        c.executionCtx.waitUntil(
          (async () => {
            await syncBookingCalendarEvents(c.env, groupId, origin);
            const summary = await getBookingSummaryForGroup(c.env.DB, groupId);
            if (summary?.paymentMethod === 'bank_transfer') {
              await notifyPaymentConfirmed(c.env, groupId, receiptPath);
            }
          })().catch(() => {}),
        );
        return c.json({ received: true, paid: true, groupId });
      }
      const result = await fulfillTicketPurchase(c.env.DB, session.id, nowJST(), todayJST(), addDaysJST);
      if (!result.ok) {
        // 発行失敗（商品欠落など）は 500 を返して Stripe に再送させる
        return c.json({ received: true, fulfilled: false, reason: result.reason }, 500);
      }
      // チケット購入完了メール（#52）。再配信（already）や情報欠落時は送らない。
      if (!result.already && result.customerId && result.productName) {
        const info = result;
        c.executionCtx.waitUntil(
          (async () => {
            const prof = (await getCustomerProfile(c.env.DB, info.customerId!)) as { email?: string; contact_name?: string } | null;
            const to = prof?.email ? String(prof.email) : '';
            if (!to) return;
            const origin = c.env.PUBLIC_BASE_URL || '';
            await sendEmail(c.env, {
              to,
              ...ticketPurchaseEmail({
                customerName: prof?.contact_name ? String(prof.contact_name) : 'お客様',
                productName: info.productName!,
                totalHours: info.totalHours ?? 0,
                validUntil: info.validUntil ?? '',
                amount: info.amount ?? 0,
                mypageUrl: origin ? `${origin}/mypage.html` : undefined,
              }),
            });
          })().catch(() => {}),
        );
      }
      return c.json({ received: true, fulfilled: true, ticketId: result.ticketId });
    }
  }
  // それ以外のイベントは受領のみ
  return c.json({ received: true });
});

export default app;
