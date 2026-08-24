import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { verifyStripeWebhook, stripeConfigured } from '../lib/stripe';
import { fulfillTicketPurchase, getBookingPaymentBySession, getCustomerProfile } from '../db/repository';
import { sendEmail, ticketPurchaseEmail } from '../lib/email';
import { settlePaidBookingSession, handleKonbiniSlipIssued, releaseKonbiniHoldForSession } from '../lib/settle-booking';
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

  // 受信イベントの記録（原因特定用・Cloudflare Observabilityで検索できる）
  {
    const s = event.data?.object as { id?: string; payment_status?: string } | undefined;
    console.log('[webhook] stripe event', { type: event.type, sessionId: s?.id, paymentStatus: s?.payment_status });
  }

  // コンビニ払込票の発行（未入金の completed）→ 枠を仮押さえ（tentative）＋受付メール（#39）。
  // カード即時決済は payment_status='paid' で来るので下の PAID_EVENTS 側で処理する。
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object as { id?: string; payment_status?: string; payment_intent?: string };
    if (s.id && s.payment_status !== 'paid') {
      const bookingPay = await getBookingPaymentBySession(c.env.DB, s.id);
      if (bookingPay && (bookingPay.kind ?? 'booking') === 'booking') {
        const origin = c.env.PUBLIC_BASE_URL || '';
        const pi = typeof s.payment_intent === 'string' ? s.payment_intent : null;
        try {
          await handleKonbiniSlipIssued(c.env, bookingPay, pi, origin, c.executionCtx);
        } catch {
          /* 仮押さえ・メール送信の失敗は Webhook 応答に影響させない（再送暴発防止） */
        }
      }
      return c.json({ received: true, pending: true });
    }
  }

  // コンビニ払込票の支払い失敗・期限切れ → 仮押さえを解放して枠を空ける（#39）
  if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
    const s = event.data.object as { id?: string };
    if (s.id) {
      const bookingPay = await getBookingPaymentBySession(c.env.DB, s.id);
      if (bookingPay && (bookingPay.kind ?? 'booking') === 'booking') {
        const origin = c.env.PUBLIC_BASE_URL || '';
        try {
          await releaseKonbiniHoldForSession(c.env, bookingPay, origin, c.executionCtx);
        } catch {
          /* 解放失敗は Cron の掃除で拾う */
        }
      }
    }
    return c.json({ received: true, released: true });
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
        // 入金確定 → 確定（成立/不成立＋返金）まで進める共通処理（Webhook・復帰ポーリング共用）
        const settled = await settlePaidBookingSession(c.env, bookingPay, session.id, piForRefund, origin, c.executionCtx);
        if (!settled.ok) return c.json({ received: true, paid: false }, 500);
        return c.json({ received: true, paid: true, ...settled });
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
