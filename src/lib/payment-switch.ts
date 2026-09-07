/**
 * 支払い方法の切替（銀行振込／コンビニ／請求書払い → カード）。
 *
 * ニーズ：銀行振込で申し込んだ後に「カードで払いたい」という変更が多い。
 * 方針：お金がまだ動いていない（未入金）予約に対して、全額のカード決済リンクを発行し、
 *   カード入金で予約を「入金済み・確定」にする。入金確定は既存の kind='booking' 経路
 *   （settlePaidBookingSession の confirmed-hold ブランチ）を再利用する。
 *   切替時に旧・銀行振込等の未入金 PaymentIntent は二重入金防止のためキャンセルする（承認入金後）。
 *
 * マイページ（会員セルフ）と管理画面（リンク発行）の両方から使う共通処理。
 */
import { createCheckoutSession, stripeConfigured, type Env as StripeEnv } from './stripe';
import { createBookingPayment, getSpaceById, getCustomerProfile } from '../db/repository';
import { nowJST } from './clock';

export interface SwitchableGroup {
  id: string;
  booking_number: string;
  space_id: string;
  customer_id: string | null;
  status: string;
  payment_status: string;
  payment_method: string | null;
  total_amount: number;
}

/**
 * カード決済への切替が可能な予約か。
 * 対象：確定済み・未入金・金額あり（＝銀行振込/コンビニ/請求書払いの入金待ち）。
 * 対象外：入金済み（カード/PayPal等）、pending（カード決済中）、tentative/cancelled、¥0/チケット。
 */
export function isCardSwitchEligible(g: {
  status: string;
  payment_status: string;
  total_amount: number;
}): boolean {
  return g.status === 'confirmed' && g.payment_status !== 'paid' && g.total_amount > 0;
}

export interface SwitchSessionResult {
  ok: boolean;
  url?: string;
  sessionId?: string;
  error?: string;
  httpStatus?: number;
}

/**
 * カード決済への切替用 Checkout セッションを発行し、booking_payments に kind='switch' で記録する。
 * 返り値の url をお客様に渡す（マイページはリダイレクト、管理画面はメール＋コピー）。
 */
export async function createCardSwitchSession(
  env: StripeEnv & { DB: D1Database; PUBLIC_BASE_URL?: string; STRIPE_SECRET_KEY?: string },
  group: SwitchableGroup,
  origin: string,
): Promise<SwitchSessionResult> {
  if (!isCardSwitchEligible(group)) {
    return { ok: false, error: 'この予約はカード決済への切替対象ではありません（入金済み、または対象外）。', httpStatus: 400 };
  }
  if (!stripeConfigured(env)) return { ok: false, error: 'Stripeが未設定です', httpStatus: 503 };

  const space = await getSpaceById(env.DB, group.space_id);
  const prof = group.customer_id ? await getCustomerProfile(env.DB, group.customer_id) : null;
  const email = prof?.email ? String(prof.email) : '';
  const payId = crypto.randomUUID();
  try {
    const session = await createCheckoutSession(env.STRIPE_SECRET_KEY!, {
      productName: `ご予約 ${group.booking_number}（${space?.name ?? ''}）`,
      amountJpy: group.total_amount,
      successUrl: `${origin}/pay-complete.html?type=booking&session={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/pay-complete.html?type=booking&status=cancel&num=${encodeURIComponent(group.booking_number)}`,
      customerEmail: email || undefined,
      clientReferenceId: payId,
      // 支払い方法の切替はカードのみ（「カードで今すぐ支払う」）。
      metadata: { kind: 'switch', groupId: group.id, bookingNumber: group.booking_number },
      paymentMethodTypes: ['card'],
    });
    await createBookingPayment(
      env.DB,
      { id: payId, groupId: group.id, provider: 'stripe', amount: group.total_amount, sessionId: session.id, kind: 'switch' },
      nowJST(),
    );
    return { ok: true, url: session.url, sessionId: session.id };
  } catch (err) {
    return { ok: false, error: 'カード決済リンクの作成に失敗しました：' + (err as Error).message, httpStatus: 502 };
  }
}
