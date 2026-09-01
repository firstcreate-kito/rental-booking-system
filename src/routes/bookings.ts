import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  getSpaceById,
  getCustomerProfile,
  getHolidays,
  getSpaceClosures,
  getActiveSeasonalRulesForSpace,
  getSpaceBookingsOnDate,
  getOccupyingIntervalsExcludingGroup,
  getSystemSettings,
  isBookingBlocked,
  getCustomerByEmail,
  getBookingGroupByNumber,
  getBookingGroupById,
  getBookingsByGroup,
  getSpaceQuestions,
  getTicketForCustomer,
  getTicketSpaceIds,
  getTicketUsageForGroup,
  buildTicketRescheduleStmts,
  buildTicketCancelPlan,
  createBookingPayment,
  setBookingPaymentBankInfo,
  createDocumentForGroup,
  getBookingPaymentBySession,
  getBookingSummaryForGroup,
  getCancelPolicies,
  refundBookingPoints,
  getOptionsByIds,
  isOptionAvailableForSpace,
  getDailyOptionUsage,
  getCouponByCodeForCustomer,
  getCouponSpaceIds,
  getPointBalance,
  getActiveCampaigns,
  peekNextBookingSeq,
  type SpaceRow,
} from '../db/repository';
import { optionSubtotal, normalizeQuantity, hasStock } from '../lib/options';
import { adminRecipients } from '../lib/notify';
import { getOptionalCustomer } from '../middleware/auth';
import type { PrimaryDiscount } from '../lib/discounts';
import { getDayType, isClosed, daysBetween, type HolidayType } from '../lib/calendar';
import {
  computeCancelCharge,
  selectCancelPolicy,
  computeAdjustment,
  type CancelPolicyTier,
} from '../lib/cancellation';
import {
  computeGroupSpacePrice,
  type SpacePricingConfig,
  type SeasonalRule,
  type DayBookingInput,
} from '../lib/pricing';
import { applyDiscounts, resolveCampaign, coveredAmountForHours, type DiscountableDay, type CampaignCandidate } from '../lib/discounts';
import {
  validateBookingItem,
  intervalsOverlap,
  type BookingValidationSpace,
  type BookingItemInput,
} from '../lib/availability';
import { todayJST, todayYmdJST, nowJST, addDaysJST } from '../lib/clock';
import { sendEmail, bookingConfirmationEmail, adminNewBookingEmail, cancellationEmail, adminCancellationEmail, rescheduleEmail, adminRescheduleEmail, adminPaymentActionAlertEmail, paymentPendingBookingEmail } from '../lib/email';
import { checkCalendarConflict, checkCalendarConflictExcluding, syncBookingCalendarEvents, deleteBookingFromCalendar } from '../lib/gcal-sync';
import { stripeConfigured, createCheckoutSession, createStripeCustomer, createBankTransferCheckout, createJpBankTransferFundingInstructions, retrieveCheckoutSession } from '../lib/stripe';
import { settlePaidBookingSession } from '../lib/settle-booking';
import { paypalConfigured, createPaypalOrder } from '../lib/paypal';

const app = new Hono<AppBindings>();

const BLACKLIST_MESSAGE = '予約が拒否されました。';

/** DBのキャンペーン行を適用判定用の候補に変換 */
function toCampaignCandidates(
  rows: Array<{
    name: string;
    start_date: string;
    end_date: string;
    discount_type: 'percent' | 'fixed';
    discount_value: number;
    apply_weekday: number;
    apply_weekend: number;
    space_id: string | null;
  }>,
): CampaignCandidate[] {
  return rows.map((r) => ({
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    discountType: r.discount_type,
    discountValue: r.discount_value,
    applyWeekday: !!r.apply_weekday,
    applyWeekend: !!r.apply_weekend,
    spaceId: r.space_id,
  }));
}


interface CreateBookingBody {
  spaceId: string;
  eventName: string;
  customer: {
    contactName: string;
    email: string;
    phone: string;
    companyName?: string;
  };
  items: Array<{ date: string; startTime: string; endTime: string; isResidence?: boolean }>;
  /** 全日程共通(per_group)オプション */
  options?: Array<{ optionId: string; quantity?: number }>;
  /** 会員のみ: 割引クーポンコード（ポイントとは併用不可） */
  couponCode?: string;
  /** 会員のみ: 使用ポイント（クーポンとは併用不可） */
  pointsToUse?: number;
  /** 会員のみ: 使用するチケット（回数券）ID（#24） */
  ticketId?: string;
  /** スペース別の追加質問への回答（#22） */
  answers?: Array<{ questionId: string; answer?: string }>;
  /** 支払い方法（#38）: 'stripe'(カード) / 'paypal' / 'invoice'(請求書) */
  paymentMethod?: string;
  /** 請求書払い時の請求書名（宛名）。invoice のとき必須 */
  invoiceName?: string;
  /** 利用目的（必須・カレンダー出力用）#59/#61 */
  purpose?: string;
  /** 利用人数（必須・カレンダー出力用）#61 */
  headcount?: number;
  /** 過去のご利用実績（任意）'利用経験あり'/'利用経験なし' #60 */
  pastUse?: string;
  /** ALBEを知ったきっかけ（任意）#60 */
  referralSource?: string;
  /** ご利用規約への同意（必須・trueのみ受付）#60 */
  termsAgreed?: boolean;
  /** ご要望・メッセージ（任意・お客様→運営への自由記述） */
  customerMessage?: string;
}

/**
 * 後払いの受付リード日数（利用日の何日前まで受け付けるか）。
 * - コンビニ払い … 払込票の有効期限が短いため 5日前まで（#67）。
 * - 銀行振込（Stripe）・請求書払い（手動）… 着金・請求書発行に日数がかかるため 7日前まで（#38）。
 *   ※銀行振込と手動請求書は同じルールで運用する。
 */
const KONBINI_LEAD_DAYS = 5;
const TRANSFER_LEAD_DAYS = 7;

function toPricingConfig(s: SpaceRow): SpacePricingConfig {
  return {
    billingType: s.billing_type,
    weekdayRate: s.weekday_rate,
    weekendRate: s.weekend_rate,
    dayRateHours: s.day_rate_hours,
    weekdayAvailable: !!s.weekday_available,
    weekendAvailable: !!s.weekend_available,
    openTime: s.open_time,
    closeTime: s.close_time,
    hasMinimum: !!s.has_minimum,
    minHours: s.min_hours,
    weekendDayRateOnly: !!s.weekend_day_rate_only,
  };
}

function toValidationSpace(s: SpaceRow): BookingValidationSpace {
  return {
    openTime: s.open_time,
    closeTime: s.close_time,
    slotMinutes: s.slot_minutes,
    bookingHorizonDays: s.booking_horizon_days,
    bookingDeadlineDays: s.booking_deadline_days,
    weekdayAvailable: !!s.weekday_available,
    weekendAvailable: !!s.weekend_available,
    closingDate: s.closing_date,
  };
}

/**
 * 会員のクーポン/ポイント指定から、割引の主役(primary)を解決・検証する。
 * @returns primary と、消費処理に必要な情報。error があれば適用不可。
 */
async function resolvePrimaryDiscount(
  db: D1Database,
  customerId: string,
  spaceId: string,
  today: string,
  couponCode: string | undefined,
  pointsToUse: number | undefined,
  ticketId?: string | undefined,
): Promise<{ primary: PrimaryDiscount; couponId?: string; ticketId?: string; error?: string }> {
  if (ticketId) {
    const ticket = await getTicketForCustomer(db, ticketId, customerId);
    if (!ticket) return { primary: { kind: 'none' }, error: 'チケットが見つかりません' };
    if (ticket.status !== 'active') return { primary: { kind: 'none' }, error: 'このチケットは利用できません' };
    if (today < ticket.valid_from || today > ticket.valid_until) return { primary: { kind: 'none' }, error: 'チケットの有効期限外です' };
    if (ticket.remaining_hours <= 0) return { primary: { kind: 'none' }, error: 'チケットの残時間がありません' };
    const tspaces = await getTicketSpaceIds(db, ticket.id);
    if (tspaces.length > 0 && !tspaces.includes(spaceId)) return { primary: { kind: 'none' }, error: 'このチケットは対象スペース外です' };
    return { primary: { kind: 'ticket', remainingHours: ticket.remaining_hours }, ticketId: ticket.id };
  }
  if (couponCode) {
    const coupon = await getCouponByCodeForCustomer(db, couponCode, customerId);
    if (!coupon) return { primary: { kind: 'none' }, error: 'クーポンが見つかりません' };
    if (coupon.status !== 'active') return { primary: { kind: 'none' }, error: 'このクーポンは利用できません' };
    if (today < coupon.valid_from || (coupon.valid_until !== null && today > coupon.valid_until)) {
      return { primary: { kind: 'none' }, error: 'クーポンの有効期限外です' };
    }
    if (coupon.remaining_hours <= 0) return { primary: { kind: 'none' }, error: 'クーポンの残時間がありません' };
    const spaces = await getCouponSpaceIds(db, coupon.id);
    if (spaces.length > 0 && !spaces.includes(spaceId)) {
      return { primary: { kind: 'none' }, error: 'このクーポンは対象スペース外です' };
    }
    return {
      primary: {
        kind: 'coupon',
        discountType: coupon.discount_type,
        discountValue: coupon.discount_value,
        remainingHours: coupon.remaining_hours,
      },
      couponId: coupon.id,
    };
  }
  if (pointsToUse && pointsToUse > 0) {
    const balance = await getPointBalance(db, customerId);
    return { primary: { kind: 'points', pointsToUse, pointBalance: balance } };
  }
  return { primary: { kind: 'none' } };
}

/** POST /api/bookings 予約作成（ゲスト対応・スペース料金のみ） */
app.post('/', async (c) => {
  const db = c.env.DB;
  let body: CreateBookingBody;
  try {
    body = await c.req.json<CreateBookingBody>();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  // 入力の基本チェック
  if (!body.spaceId || !body.eventName || !body.customer || !Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: 'spaceId, eventName, customer, items は必須です' }, 400);
  }
  const { contactName, email, phone, companyName } = body.customer ?? {};
  if (!contactName || !email || !phone) {
    return c.json({ error: 'お名前・メール・電話は必須です' }, 400);
  }

  const space = await getSpaceById(db, body.spaceId);
  if (!space || !space.is_active) return c.json({ error: 'space not found' }, 404);

  // 申込はお問い合わせのみの施設（#移行・inquiry_only）はネット直接予約を受け付けない。
  // フロント（index.html）はクリックをお問い合わせ誘導に差し替えるが、それはブラウザ側の
  // 表示ガードにすぎない。別ページ・ディープリンク・再予約・直接APIなど画面ガードを通らない
  // 経路でも作成されないよう、サーバー側でも必ず拒否する（管理者の代理予約・商談中は別経路のため対象外）。
  if (space.inquiry_only) {
    return c.json(
      { error: 'このスペースはネットでの直接予約を承っておりません。ご予約・ご相談はお問い合わせよりお願いいたします。', code: 'INQUIRY_ONLY' },
      403,
    );
  }

  // 会員ログインの有無（クーポン/ポイントは会員のみ）
  const member = await getOptionalCustomer(c);

  // ブラックリストチェック（#69）。会員・ゲスト双方に適用。
  // メール または 電話 のどちらかがブロック対象に一致したら予約を受け付けない
  // （連絡先を変えての再予約も、どちらか一方が一致すれば捕捉する）。
  if (await isBookingBlocked(db, email, phone)) {
    return c.json({ error: BLACKLIST_MESSAGE }, 403);
  }

  const settings = await getSystemSettings(db);
  const defaultDeadline = Number(settings.get('default_booking_deadline_days') ?? '0');
  const today = todayJST();

  // 支払い方法の検証（#38/#42）: 施設ごとの許可・振込の締切
  // allow_invoice フラグは「銀行振込（Stripe）」の受付可否を表す。
  // 公開予約では bank_transfer（Stripe銀行振込）を使い、invoice（自社口座請求書）は
  // 管理者の代理予約など特別対応でのみ使用する。
  const allowedMethods: Record<string, boolean> = {
    stripe: !!space.allow_card,
    paypal: !!space.allow_paypal,
    bank_transfer: !!space.allow_invoice,
    // 請求書払い（手動・自社口座／Stripe非経由）は専用フラグで独立管理（#88関連）
    invoice: !!space.allow_manual_invoice,
  };
  const paymentMethod =
    String(body.paymentMethod ?? '').trim() ||
    (space.allow_card ? 'stripe' : space.allow_paypal ? 'paypal' : 'bank_transfer');
  if (!allowedMethods[paymentMethod]) {
    return c.json({ error: 'この施設では選択されたお支払い方法はご利用いただけません' }, 400);
  }
  // ゲスト（未登録＝非会員）はクレジットカード即時決済のみ（#55）。
  // 振込・請求書は入金確認や督促に本人特定が必要なため会員限定とする。
  if (!member && paymentMethod !== 'stripe') {
    return c.json({ error: '会員登録なしのご予約は、クレジットカード決済のみご利用いただけます。銀行振込をご希望の場合は会員登録をお願いします。', code: 'GUEST_CARD_ONLY' }, 400);
  }
  let invoiceName: string | null = null;
  if (paymentMethod === 'invoice' || paymentMethod === 'bank_transfer') {
    // 請求書名（宛名）は任意。未入力の場合は申込者の個人名を宛名に用いる（領収書生成時にフォールバック）。#41
    invoiceName = String(body.invoiceName ?? '').trim() || null;
    // 銀行振込・請求書払いは入金までに日数がかかるため、ご利用日まで一定の猶予を必須とする。
    const methodLabel = paymentMethod === 'invoice' ? '請求書払い' : '銀行振込';
    const earliestDate = [...body.items].map((i) => i.date).sort()[0];
    if (earliestDate < addDaysJST(today, TRANSFER_LEAD_DAYS)) {
      return c.json({ error: `${methodLabel}はご利用日の${TRANSFER_LEAD_DAYS}日前までの受付となります。${TRANSFER_LEAD_DAYS}日以内のご予約はカード決済をご利用ください。` }, 400);
    }
  }
  // 利用目的・利用人数（必須）#59/#61、過去利用・きっかけ（任意）#60、規約同意（必須）#60
  const purpose = String(body.purpose ?? '').trim() || null;
  const headcountNum = Number(body.headcount);
  const headcount = Number.isFinite(headcountNum) && headcountNum > 0 ? Math.floor(headcountNum) : null;
  const pastUse = String(body.pastUse ?? '').trim() || null;
  const referralSource = String(body.referralSource ?? '').trim() || null;
  // ご要望・メッセージ（任意・自由記述）。長すぎる入力は保存前に丸める（安全側）。
  const customerMessage = String(body.customerMessage ?? '').trim().slice(0, 2000) || null;
  if (!purpose) return c.json({ error: '利用目的を選択してください' }, 400);
  if (!headcount) return c.json({ error: '利用人数を入力してください' }, 400);
  if (body.termsAgreed !== true) return c.json({ error: 'ご利用規約への同意が必要です' }, 400);

  // 期間の祝日・季節料金・キャンペーン
  const itemDates = body.items.map((i) => i.date).sort();
  const [holidays, seasonalRows, campaignRows] = await Promise.all([
    getHolidays(db, itemDates[0], itemDates[itemDates.length - 1]),
    getActiveSeasonalRulesForSpace(db, space.id),
    getActiveCampaigns(db),
  ]);
  const holidayMap = holidays as ReadonlyMap<string, HolidayType>;
  const seasonalRules: SeasonalRule[] = seasonalRows.map((r) => ({
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    surchargePct: r.surcharge_pct,
    dayRateOnly: !!r.day_rate_only,
  }));

  const valSpace = toValidationSpace(space);
  const errors: Array<{ index: number; code: string; message: string }> = [];

  // バリデーション + 競合チェック
  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    const dayType = getDayType(item.date, holidayMap);
    const closures = await getSpaceClosures(db, space.id, item.date, item.date);
    const closed = isClosed(item.date, { holidays: holidayMap, spaceClosureDates: closures });

    const itemErrors = validateBookingItem(valSpace, item as BookingItemInput, {
      today,
      dayType,
      isClosed: closed,
      defaultDeadlineDays: defaultDeadline,
    });
    for (const e of itemErrors) errors.push({ index: i, ...e });

    // 競合チェック（占有予約と時間帯が重なるか）
    const existing = await getSpaceBookingsOnDate(db, space.id, item.date);
    const conflict = existing.some((b) =>
      intervalsOverlap(item.startTime, item.endTime, b.start_time, b.end_time),
    );
    if (conflict) {
      errors.push({ index: i, code: 'CONFLICT', message: `${item.date} ${item.startTime}-${item.endTime} は既に予約があります` });
    }
  }

  if (errors.length > 0) {
    return c.json({ error: 'validation failed', details: errors }, 409);
  }

  // 料金計算（ゲストは割引なし・オプションなし）
  const dayInputs: DayBookingInput[] = body.items.map((i) => ({
    date: i.date,
    startTime: i.startTime,
    endTime: i.endTime,
    isResidence: i.isResidence,
  }));
  const group = computeGroupSpacePrice(toPricingConfig(space), dayInputs, {
    holidays: holidayMap,
    seasonalRules,
  });
  const discountableDays: DiscountableDay[] = group.days.map((d) => ({
    billableHours: d.billableHours,
    price: d.price,
  }));
  // 該当するキャンペーンを解決（予約の全日程が対象の場合のみ適用）
  const resolvedCampaign = resolveCampaign(
    toCampaignCandidates(campaignRows),
    group.days.map((d) => ({ date: d.date, dayType: getDayType(d.date, holidayMap), price: d.price, seasonalPct: d.seasonalPct })),
    space.id,
  );

  // オプション処理（全日程共通 per_group、在庫は各日でチェック）
  const optionSelections: Array<{ optionId: string; quantity: number; subtotal: number }> = [];
  let optionsTotal = 0;
  if (body.options && body.options.length > 0) {
    const ids = body.options.map((o) => o.optionId);
    const optMap = await getOptionsByIds(db, ids);
    for (const req of body.options) {
      const opt = optMap.get(req.optionId);
      if (!opt || !opt.is_active) {
        return c.json({ error: `オプションが見つかりません: ${req.optionId}` }, 400);
      }
      if (!(await isOptionAvailableForSpace(db, space.id, opt.id))) {
        return c.json({ error: `${opt.name} はこのスペースで利用できません` }, 400);
      }
      const norm = normalizeQuantity(
        { id: opt.id, type: opt.type, priceType: opt.price_type, unitPrice: opt.unit_price, maxQty: opt.max_qty, stockTotal: opt.stock_total },
        req.quantity ?? 1,
      );
      if (norm.error) return c.json({ error: `${opt.name}: ${norm.error}` }, 400);

      // 各利用日で在庫確認（共通在庫は横断集計）
      for (const item of body.items) {
        const used = await getDailyOptionUsage(db, opt.id, item.date);
        if (!hasStock(opt.stock_total, used, norm.quantity)) {
          return c.json(
            { error: `${opt.name} は ${item.date} の在庫が不足しています（残${Math.max(0, (opt.stock_total ?? 0) - used)}）` },
            409,
          );
        }
      }
      const subtotal = optionSubtotal(opt.price_type, opt.unit_price, norm.quantity);
      optionSelections.push({ optionId: opt.id, quantity: norm.quantity, subtotal });
      optionsTotal += subtotal;
    }
  }

  // 割引の主役を解決（会員のみ。クーポン/チケット/ポイントのいずれか1つ）
  let primary: PrimaryDiscount = { kind: 'none' };
  let couponId: string | undefined;
  let usedTicketId: string | undefined;
  if (member && (body.couponCode || body.pointsToUse || body.ticketId)) {
    const resolved = await resolvePrimaryDiscount(db, member.id, space.id, today, body.couponCode, body.pointsToUse, body.ticketId);
    if (resolved.error) return c.json({ error: resolved.error }, 400);
    primary = resolved.primary;
    couponId = resolved.couponId;
    usedTicketId = resolved.ticketId;
  }

  const pointRate = Number(settings.get('point_rate') ?? '1');
  const totals = applyDiscounts({
    days: discountableDays,
    primary,
    campaign: resolvedCampaign?.rule,
    optionsTotal,
    pointRate,
  });

  const now = nowJST();
  let customerId: string;
  if (member) {
    // 会員予約: 会員アカウントに紐付け
    customerId = member.id;
  } else {
    // ゲスト予約: 既存を再利用、なければ作成
    const existingCustomer = await getCustomerByEmail(db, email);
    if (existingCustomer?.is_blocked) {
      return c.json({ error: BLACKLIST_MESSAGE }, 403);
    }
    customerId = existingCustomer?.id ?? crypto.randomUUID();
    if (!existingCustomer) {
      await db
        .prepare(
          `INSERT INTO customers (id, email, is_registered, company_name, contact_name, phone, status_id, created_at)
           VALUES (?, ?, 0, ?, ?, ?, 'general', ?)`,
        )
        .bind(customerId, email, companyName ?? null, contactName, phone, now)
        .run();
    }
  }

  // Googleカレンダー（予約台帳の正）を確定直前に照会。埋まっていれば拒否（ダブルブッキング回避B）。
  // 照会自体が失敗（認証/権限等）しても予約は止めず、書き込み側の警告で拾う。
  const calCheck = await checkCalendarConflict(c.env, space.google_calendar_id, body.items);
  if (calCheck.conflict) {
    return c.json(
      { error: `申し訳ありません、${calCheck.conflict} はたった今埋まりました。お手数ですが別の時間をお選びください。`, code: 'CALENDAR_CONFLICT' },
      409,
    );
  }

  // スペース別の追加質問（#22）: 必須チェック＋回答を質問文スナップショットで保存
  const questions = await getSpaceQuestions(db, space.id);
  const answerMap = new Map((body.answers ?? []).map((a) => [a.questionId, (a.answer ?? '').trim()]));
  const answerRows: Array<{ questionId: string; label: string; answer: string }> = [];
  for (const q of questions) {
    const ans = answerMap.get(q.id) ?? '';
    if (q.required && !ans) return c.json({ error: `「${q.label}」は必須です`, code: 'ANSWER_REQUIRED' }, 400);
    if (ans) answerRows.push({ questionId: q.id, label: q.label, answer: ans });
  }

  // 支払い状態（#35）: 請求書=invoice、0円(全額チケット等)=paid、カード/PayPal=unpaid（決済後にpaid）
  const paymentStatus = paymentMethod === 'invoice' ? 'invoice' : totals.total <= 0 ? 'paid' : 'unpaid';

  // 決済先行フロー（#68）: カード/PayPal（有料）は「pending」で作成し、カレンダーには書かない。
  //   入金確定時に空きを再確認して confirmed へ昇格（埋まっていたら不成立＋返金）。
  // 銀行振込・コンビニ払いは「入金を待つだけ＝ほぼ予約成立」なので confirmed（赤枠）で
  //   枠を確保する（tentative＝商談中は営業担当の人手用に予約する）。未入金のまま期限を
  //   過ぎたら自動キャンセルして枠を解放する（#39）。請求書・0円も従来どおり confirmed。
  const paymentFirst = (paymentMethod === 'stripe' || paymentMethod === 'paypal') && totals.total > 0;
  const initialStatus = paymentFirst ? 'pending' : 'confirmed';

  // 予約番号採番 + 挿入（UNIQUE衝突時はリトライ）
  const ymd = todayYmdJST();
  const groupId = crypto.randomUUID();
  const bookingIds = body.items.map(() => crypto.randomUUID());
  // 当初利用日（変更・キャンセル判定の基準・以後不変）＝グループ内で最も早い利用日（#76）
  const originalDate = body.items.map((it) => it.date).sort()[0];
  let bookingNumber = '';

  // ------------------------------------------------------------------
  // ダブルブッキング防御（#26）— 第1段階：予約枠を「重複が無ければ」原子的に確保
  //   各日の予約行を条件付きINSERT（WHERE NOT EXISTS 重複）で入れる。
  //   D1（SQLite）は書き込みを直列化するため、数秒差の同時予約でも
  //   後続のINSERTは先着の行を見て0件挿入となり、二重予約を防ぐ。
  //   追加のAPI通信は無く、既存インデックス idx_bookings_space_date を使うため高速。
  //   ※特典（クーポン/チケット/ポイント）消費は枠の確保後（第2段階）にのみ行う。
  // ------------------------------------------------------------------
  let reserved = false;
  let slotConflict = false;
  for (let attempt = 0; attempt < 5 && !reserved && !slotConflict; attempt++) {
    const seq = await peekNextBookingSeq(db, ymd);
    bookingNumber = `${ymd}-${String(seq).padStart(3, '0')}`;
    const reserveStmts: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO booking_groups (id, booking_number, customer_id, space_id, event_name, total_amount, original_total_amount, original_date, payment_method, invoice_name, payment_status, purpose, headcount, past_use, referral_source, customer_message, status, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?)`,
        )
        .bind(groupId, bookingNumber, customerId, space.id, body.eventName, totals.total, totals.total, originalDate, paymentMethod, invoiceName, paymentStatus, purpose, headcount, pastUse, referralSource, customerMessage, initialStatus, now),
    ];
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];
      const day = group.days[i];
      reserveStmts.push(
        db
          .prepare(
            `INSERT INTO bookings
             (id, group_id, space_id, date, start_time, end_time, billable_hours, billing_mode, is_residence, rate, price, status, source)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web'
             WHERE NOT EXISTS (
               SELECT 1 FROM bookings b
               WHERE b.space_id = ? AND b.date = ?
                 AND b.status IN ('confirmed','tentative')
                 AND ? < b.end_time AND b.start_time < ?
             )`,
          )
          .bind(
            bookingIds[i],
            groupId,
            space.id,
            item.date,
            item.startTime,
            item.endTime,
            day.billableHours,
            day.billingMode,
            day.isResidence ? 1 : 0,
            day.rate,
            day.price,
            initialStatus,
            space.id,
            item.date,
            item.startTime,
            item.endTime,
          ),
      );
    }
    try {
      await db.batch(reserveStmts);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('UNIQUE') && attempt < 4) continue; // 予約番号の採番衝突 → リトライ
      throw err;
    }
    // 全日程の枠が確保できたか（条件付きINSERTで弾かれた日が無いか）を確認
    const cntRow = await db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE group_id = ?').bind(groupId).first<{ n: number }>();
    if ((cntRow?.n ?? 0) === body.items.length) {
      reserved = true;
    } else {
      // 直前に別の予約が同じ時間帯を確保 → 競合。確保途中の行を取り消す（特典未消費）。
      await db.batch([
        db.prepare('DELETE FROM bookings WHERE group_id = ?').bind(groupId),
        db.prepare('DELETE FROM booking_groups WHERE id = ?').bind(groupId),
      ]);
      slotConflict = true;
    }
  }
  if (slotConflict) {
    return c.json(
      { error: 'たった今、選択された時間帯に別のご予約が入りました。お手数ですが時間帯を選び直してください。', code: 'CONFLICT' },
      409,
    );
  }
  if (!reserved) {
    return c.json({ error: '予約番号の採番に失敗しました。もう一度お試しください。' }, 500);
  }

  // ------------------------------------------------------------------
  // 第2段階：確保できた枠に対して、オプション・追加質問・特典消費を反映
  // ------------------------------------------------------------------
  const stmts: D1PreparedStatement[] = [];
  // 会員の連絡先プロフィールを補完（#91）。Google/LINE/マジックリンク/コードで会員登録すると
  // 氏名・電話が空のことがあるため、予約フォームで入力された値で「空の項目だけ」を埋める。
  // 既に登録済みの値（通常のメール会員登録など）は上書きしない。
  if (member) {
    stmts.push(
      db
        .prepare(
          `UPDATE customers SET
             contact_name = CASE WHEN contact_name IS NULL OR contact_name = '' THEN ? ELSE contact_name END,
             phone = CASE WHEN phone IS NULL OR phone = '' THEN ? ELSE phone END,
             company_name = CASE WHEN (company_name IS NULL OR company_name = '') AND ? <> '' THEN ? ELSE company_name END
           WHERE id = ?`,
        )
        .bind(contactName, phone, companyName ?? '', companyName ?? '', customerId),
    );
  }
  for (const sel of optionSelections) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO booking_option_selections (id, group_id, option_id, quantity, subtotal)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), groupId, sel.optionId, sel.quantity, sel.subtotal),
    );
  }
  for (const a of answerRows) {
    stmts.push(
      db
        .prepare('INSERT INTO booking_answers (id, group_id, question_id, label, answer, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), groupId, a.questionId, a.label, a.answer, now),
    );
  }
  // クーポン消費（会員）
  if (couponId && primary.kind === 'coupon' && totals.couponHoursConsumed > 0) {
    stmts.push(
      db
        .prepare(
          `UPDATE discount_coupons
           SET remaining_hours = remaining_hours - ?,
               status = CASE WHEN remaining_hours - ? <= 0 THEN 'exhausted' ELSE status END
           WHERE id = ?`,
        )
        .bind(totals.couponHoursConsumed, totals.couponHoursConsumed, couponId),
    );
    stmts.push(
      db
        .prepare(
          `INSERT INTO coupon_usage (id, coupon_id, booking_id, hours_consumed, original_price, discounted_price, used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), couponId, bookingIds[0], totals.couponHoursConsumed, totals.spaceFee, totals.spaceFee - totals.primaryDiscount, now),
    );
  }
  // チケット消費（会員）#24
  if (usedTicketId && primary.kind === 'ticket' && totals.ticketHoursConsumed > 0) {
    stmts.push(
      db
        .prepare(
          `UPDATE tickets
           SET remaining_hours = remaining_hours - ?,
               status = CASE WHEN remaining_hours - ? <= 0 THEN 'exhausted' ELSE status END
           WHERE id = ?`,
        )
        .bind(totals.ticketHoursConsumed, totals.ticketHoursConsumed, usedTicketId),
    );
    stmts.push(
      db
        .prepare(
          `INSERT INTO ticket_usage (id, ticket_id, booking_id, hours_consumed, original_price, discounted_price, used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), usedTicketId, bookingIds[0], totals.ticketHoursConsumed, totals.spaceFee, totals.spaceFee - totals.primaryDiscount, now),
    );
  }
  // ポイント消費（会員）
  if (primary.kind === 'points' && totals.pointsUsed > 0) {
    const balanceAfter = primary.pointBalance - totals.pointsUsed;
    stmts.push(
      db.prepare('UPDATE customers SET point_balance = point_balance - ? WHERE id = ?').bind(totals.pointsUsed, customerId),
    );
    stmts.push(
      db
        .prepare(
          `INSERT INTO point_log (id, customer_id, type, amount, balance_after, group_id, description, created_at)
           VALUES (?, ?, 'use', ?, ?, ?, '予約でのポイント利用', ?)`,
        )
        .bind(crypto.randomUUID(), customerId, totals.pointsUsed, balanceAfter, groupId, now),
    );
  }
  if (stmts.length) await db.batch(stmts);

  // 請求書払い（銀行振込）の場合は請求書を自動発行（#41）。失敗しても予約は成立させる。
  if (paymentMethod === 'invoice' && totals.total > 0) {
    try {
      await createDocumentForGroup(db, groupId, 'invoice');
    } catch {
      /* 書類発行失敗は予約成立に影響させない */
    }
  }

  const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  // Googleカレンダー（予約台帳の正）へリッチ内容で書き込み＋イベントID保存（#54関連）。
  // 決済先行（#68）の pending はここでは書き込まない（入金確定時に確定・書き込み）。
  const gcalResult = paymentFirst ? { warning: null } : await syncBookingCalendarEvents(c.env, groupId, origin);

  // 通知メール（お客様宛の予約確認 + 管理者宛の新規通知）。
  // 失敗しても予約は成立させる（バックグラウンド送信）。
  const mailDays = body.items.map((i) => ({ date: i.date, startTime: i.startTime, endTime: i.endTime }));
  // 予約フォームの追加項目をメールにも記載（#60）：利用目的・人数・過去利用・きっかけ
  const mailExtras = [
    { label: '利用目的', value: purpose ?? '' },
    { label: '利用人数', value: headcount ? `${headcount}名` : '' },
    { label: '過去のご利用実績', value: pastUse ?? '' },
    { label: 'ALBEを知ったきっかけ', value: referralSource ?? '' },
    { label: 'ご要望・メッセージ', value: customerMessage ?? '' },
  ].filter((e) => e.value);
  const emailData = {
    bookingNumber,
    spaceName: space.name,
    eventName: body.eventName,
    customerName: contactName,
    days: mailDays,
    total: totals.total,
    status: 'confirmed' as const,
    extras: mailExtras,
    // 会員は書類（請求書・領収書）をマイページからDLできる。案内リンクを添える（#41）
    mypageUrl: member ? `${origin}/mypage.html` : undefined,
    // ご予約の確認・変更ページ（#75。ゲスト・会員問わず番号プリフィルで案内）
    changeUrl: `${origin}/booking-change/?num=${encodeURIComponent(bookingNumber)}`,
    isInvoice: paymentMethod === 'invoice',
  };
  // 予約確認メールの送信可否。
  //  - pending（カード/PayPal）… 入金確定時に送る（ここでは送らない）
  //  - 銀行振込（confirmed・未入金）… 下の決済ブロックで「お支払い待ち（未入金は自動キャンセル）」
  //    メールを送るため、ここでは送らない
  //  - 請求書払い（confirmed・未入金／total>0）… 銀行振込と同じルール。ここで「お支払い待ち」
  //    メールを送る（振込先は当社発行の請求書に記載）。
  //  - confirmed（0円 等）… ここで通常の確定メールを送る
  const invoicePending = paymentMethod === 'invoice' && totals.total > 0;
  if (initialStatus === 'confirmed' && paymentMethod !== 'bank_transfer') {
    if (invoicePending && email) {
      const pend = paymentPendingBookingEmail({
        customerName: contactName || 'お客様',
        bookingNumber,
        spaceName: space.name,
        eventName: body.eventName,
        days: mailDays,
        total: totals.total,
        paymentMethodLabel: '請求書払い',
        viaStripe: false, // 振込先は当社発行の請求書（マイページDL可）に記載
        mypageUrl: member ? `${origin}/mypage.html` : undefined,
      });
      c.executionCtx.waitUntil(sendEmail(c.env, { to: email, ...pend }));
    } else {
      const confirm = bookingConfirmationEmail(emailData);
      c.executionCtx.waitUntil(sendEmail(c.env, { to: email, ...confirm }));
    }
    // 管理者宛の新規予約通知（請求書払いは入金確認を手動で行うため必ず通知する）
    const admins = await adminRecipients(c.env, space.id);
    if (admins.length) {
      const adminMail = adminNewBookingEmail({ ...emailData, customerEmail: email, customerPhone: phone });
      c.executionCtx.waitUntil(sendEmail(c.env, { to: admins, ...adminMail }));
    }
  }

  // オンライン決済: 予約枠を確保できたので、決済ページを作成して誘導（#35）
  // どちらも checkoutUrl を返し、フロントは同じ処理でリダイレクトする。
  let checkoutUrl: string | null = null;
  // 決済ページ作成が失敗した場合の理由（診断用にフロントへ返す）。
  let checkoutError: string | null = null;
  if (paymentMethod === 'stripe' && totals.total > 0) {
    if (!stripeConfigured(c.env)) {
      checkoutError = 'stripe_not_configured';
    } else {
      const payId = crypto.randomUUID();
      // コンビニ払いの可否（#67）：モード③かつ会員かつ利用5日前以上、さらに本番で有効化済み(env)のときのみ。
      // ゲストや直前(<5日)はカードのみ（未入金リスク回避）。それ以外はカードのみを明示してコンビニを除外。
      const konbiniReady = String(c.env.STRIPE_KONBINI_ENABLED ?? '').toLowerCase() === 'true';
      const earliestUse = [...body.items].map((i) => i.date).sort()[0];
      const leadDays = daysBetween(today, earliestUse);
      const konbiniOk =
        konbiniReady && space.payment_mode === 'card_konbini_bank' && !!member && leadDays >= KONBINI_LEAD_DAYS;
      try {
        const session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY!, {
          productName: `ご予約 ${bookingNumber}（${space.name}）`,
          amountJpy: totals.total,
          successUrl: `${origin}/pay-complete.html?type=booking&session={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${origin}/pay-complete.html?type=booking&status=cancel&num=${encodeURIComponent(bookingNumber)}`,
          customerEmail: email || undefined,
          clientReferenceId: payId,
          metadata: { kind: 'booking', groupId, bookingNumber },
          paymentMethodTypes: konbiniOk ? ['card', 'konbini'] : ['card'],
          konbiniExpiresAfterDays: konbiniOk ? 3 : undefined,
        });
        await createBookingPayment(c.env.DB, { id: payId, groupId, provider: 'stripe', amount: totals.total, sessionId: session.id }, now);
        checkoutUrl = session.url;
      } catch (err) {
        // 決済ページ作成に失敗しても予約は確保済み（未入金）。案内はフロント側で行う。
        checkoutUrl = null;
        checkoutError = 'stripe_error: ' + (err as Error).message;
      }
    }
  } else if (paymentMethod === 'paypal' && totals.total > 0) {
    if (!paypalConfigured(c.env)) {
      checkoutError = 'paypal_not_configured';
    } else {
      const payId = crypto.randomUUID();
      try {
        const order = await createPaypalOrder(c.env, {
          amountJpy: totals.total,
          referenceId: groupId,
          invoiceId: payId,
          returnUrl: `${origin}/pay-complete.html?type=booking&provider=paypal`,
          cancelUrl: `${origin}/pay-complete.html?type=booking&status=cancel&num=${encodeURIComponent(bookingNumber)}`,
          brandName: 'レンタルスペースALBE',
        });
        // PayPalの注文IDを stripe_session_id 列に保存（外部決済の照合キーとして流用）
        await createBookingPayment(c.env.DB, { id: payId, groupId, provider: 'paypal', amount: totals.total, sessionId: order.orderId }, now);
        checkoutUrl = order.approveUrl;
      } catch (err) {
        checkoutUrl = null;
        checkoutError = 'paypal_error: ' + (err as Error).message;
      }
    }
  } else if (paymentMethod === 'bank_transfer' && totals.total > 0) {
    // Stripe 銀行振込（customer_balance / jp_bank_transfer）#42
    // お客様に振込専用の仮想口座を案内 → 入金確定は async_payment_succeeded(webhook) で処理し領収書を自動発行。
    if (!stripeConfigured(c.env)) {
      checkoutError = 'stripe_not_configured';
    } else {
      const payId = crypto.randomUUID();
      try {
        const customerId = await createStripeCustomer(c.env.STRIPE_SECRET_KEY!, {
          email: email || undefined,
          name: invoiceName || contactName || undefined,
        });
        const session = await createBankTransferCheckout(c.env.STRIPE_SECRET_KEY!, {
          productName: `ご予約 ${bookingNumber}（${space.name}）`,
          amountJpy: totals.total,
          successUrl: `${origin}/pay-complete.html?type=booking&method=bank&session={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${origin}/pay-complete.html?type=booking&status=cancel&num=${encodeURIComponent(bookingNumber)}`,
          customerId,
          clientReferenceId: payId,
          metadata: { kind: 'booking', groupId, bookingNumber },
        });
        await createBookingPayment(c.env.DB, { id: payId, groupId, provider: 'stripe', amount: totals.total, sessionId: session.id }, now);
        checkoutUrl = session.url;
        // 振込先（仮想口座）を取得（ベストエフォート）。取得できればマイページ表示用に保存する。
        let bankInfo: Awaited<ReturnType<typeof createJpBankTransferFundingInstructions>> = null;
        try {
          bankInfo = await createJpBankTransferFundingInstructions(c.env.STRIPE_SECRET_KEY!, customerId);
          if (bankInfo) await setBookingPaymentBankInfo(c.env.DB, payId, JSON.stringify(bankInfo));
        } catch {
          /* 口座情報の取得失敗はメール送信に影響させない（下で必ず案内メールを送る） */
        }
        // ALBEからの「お支払い待ち予約受付」メールは Stripe とは別に必ず送る（#39）。
        // 振込先はStripeのメールに記載されるため、こちらは予約内容＋期限内未入金は自動キャンセルの旨を案内。
        void bankInfo; // 口座情報はマイページ表示用に保存済み（メール本文には載せない）
        if (email) {
          const mail = paymentPendingBookingEmail({
            customerName: contactName || 'お客様',
            bookingNumber,
            spaceName: space.name,
            eventName: body.eventName,
            days: mailDays,
            total: totals.total,
            paymentMethodLabel: '銀行振込',
            mypageUrl: origin ? `${origin}/mypage.html` : undefined,
          });
          c.executionCtx.waitUntil(sendEmail(c.env, { to: email, ...mail }));
        }
      } catch (err) {
        checkoutUrl = null;
        checkoutError = 'bank_transfer_error: ' + (err as Error).message;
      }
    }
  }

  return c.json(
    {
      bookingNumber,
      groupId,
      total: totals.total,
      spaceFee: totals.spaceFee,
      optionsTotal,
      primaryKind: totals.primaryKind,
      primaryDiscount: totals.primaryDiscount,
      couponHoursConsumed: totals.couponHoursConsumed,
      pointsUsed: totals.pointsUsed,
      pointsEarned: totals.pointsEarned,
      isMember: !!member,
      paymentMethod,
      paymentStatus,
      checkoutUrl,
      checkoutError,
      invoiceName,
      days: group.days.map((d) => ({
        date: d.date,
        dayType: d.dayType,
        billingMode: d.billingMode,
        billableHours: d.billableHours,
        price: d.price,
        isResidence: d.isResidence,
      })),
      calendarWarning: gcalResult.warning ?? null,
    },
    201,
  );
});

/** GET /api/bookings/payment-status?session=... 予約のカード決済 反映状況（決済完了ページ用）#35 */
app.get('/payment-status', async (c) => {
  const sessionId = c.req.query('session');
  if (!sessionId) return c.json({ status: 'unknown' });
  let pay = await getBookingPaymentBySession(c.env.DB, sessionId);
  if (!pay) return c.json({ status: 'unknown' });
  let g = await getBookingGroupById(c.env.DB, pay.group_id);
  // Webhook が遅延・不達でも確定できるよう、未入金・pending のときは Stripe に直接照会して
  // 入金済みなら Webhook と同じ確定処理をここで実行する（#68 補強・カード決済先行の取りこぼし防止）。
  if (pay.status !== 'paid' && g?.status === 'pending' && stripeConfigured(c.env)) {
    try {
      const sess = await retrieveCheckoutSession(c.env.STRIPE_SECRET_KEY!, sessionId);
      if (sess && sess.paymentStatus === 'paid') {
        const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
        await settlePaidBookingSession(c.env, pay, sessionId, sess.paymentIntent, origin, c.executionCtx);
        pay = (await getBookingPaymentBySession(c.env.DB, sessionId)) || pay;
        g = await getBookingGroupById(c.env.DB, pay.group_id);
      }
    } catch {
      /* 照会失敗時は従来どおり現在のステータスを返す */
    }
  }
  const booking = await getBookingSummaryForGroup(c.env.DB, pay.group_id);
  // 決済先行（#68）：グループ状態で成立/不成立を判定。failed=満室で不成立・返金。
  let status = pay.status;
  if (g?.status === 'failed') status = 'failed';
  else if (g?.status === 'pending') status = 'processing'; // 入金確定・確定待ち
  return c.json({ status, groupId: pay.group_id, booking });
});

/**
 * POST /api/bookings/quote 料金見積もり（保存しない）
 * body: { spaceId, items:[{date,startTime,endTime,isResidence?}], options?:[{optionId,quantity?}] }
 */
app.post('/quote', async (c) => {
  const db = c.env.DB;
  let body: { spaceId?: string; items?: Array<{ date: string; startTime: string; endTime: string; isResidence?: boolean }>; options?: Array<{ optionId: string; quantity?: number }>; couponCode?: string; pointsToUse?: number; ticketId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (!body.spaceId || !Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: 'spaceId, items は必須です' }, 400);
  }
  const space = await getSpaceById(db, body.spaceId);
  if (!space || !space.is_active) return c.json({ error: 'space not found' }, 404);
  // 申込はお問い合わせのみの施設は見積り（＝予約フローの入口）も拒否する（迂回路の遮断）。
  if (space.inquiry_only) {
    return c.json(
      { error: 'このスペースはネットでの直接予約を承っておりません。ご予約・ご相談はお問い合わせよりお願いいたします。', code: 'INQUIRY_ONLY' },
      403,
    );
  }

  // 会員ログイン時のみ クーポン/ポイントを見積りに反映
  const member = await getOptionalCustomer(c);

  const settings = await getSystemSettings(db);
  const defaultDeadline = Number(settings.get('default_booking_deadline_days') ?? '0');
  const today = todayJST();
  const itemDates = body.items.map((i) => i.date).sort();
  const [holidays, seasonalRows, campaignRows] = await Promise.all([
    getHolidays(db, itemDates[0], itemDates[itemDates.length - 1]),
    getActiveSeasonalRulesForSpace(db, space.id),
    getActiveCampaigns(db),
  ]);
  const holidayMap = holidays as ReadonlyMap<string, HolidayType>;
  const seasonalRules: SeasonalRule[] = seasonalRows.map((r) => ({ name: r.name, startDate: r.start_date, endDate: r.end_date, surchargePct: r.surcharge_pct, dayRateOnly: !!r.day_rate_only }));

  // 検証（エラーは warnings として返す。見積り自体は算出）
  const valSpace = toValidationSpace(space);
  const warnings: Array<{ index: number; code: string; message: string }> = [];
  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    const dayType = getDayType(item.date, holidayMap);
    const closures = await getSpaceClosures(db, space.id, item.date, item.date);
    const closed = isClosed(item.date, { holidays: holidayMap, spaceClosureDates: closures });
    for (const e of validateBookingItem(valSpace, item as BookingItemInput, { today, dayType, isClosed: closed, defaultDeadlineDays: defaultDeadline })) {
      warnings.push({ index: i, ...e });
    }
  }

  let group;
  try {
    group = computeGroupSpacePrice(toPricingConfig(space), body.items.map((i) => ({ date: i.date, startTime: i.startTime, endTime: i.endTime, isResidence: i.isResidence })) as DayBookingInput[], { holidays: holidayMap, seasonalRules });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  // オプション小計（在庫チェックはしない、金額のみ）
  let optionsTotal = 0;
  const optionLines: Array<{ optionId: string; name: string; quantity: number; subtotal: number }> = [];
  if (body.options && body.options.length > 0) {
    const optMap = await getOptionsByIds(db, body.options.map((o) => o.optionId));
    for (const req of body.options) {
      const opt = optMap.get(req.optionId);
      if (!opt) continue;
      const norm = normalizeQuantity({ id: opt.id, type: opt.type, priceType: opt.price_type, unitPrice: opt.unit_price, maxQty: opt.max_qty, stockTotal: opt.stock_total }, req.quantity ?? 1);
      if (norm.error) continue;
      const subtotal = optionSubtotal(opt.price_type, opt.unit_price, norm.quantity);
      optionLines.push({ optionId: opt.id, name: opt.name, quantity: norm.quantity, subtotal });
      optionsTotal += subtotal;
    }
  }

  // 割引の主役を解決（会員のみ）
  let primary: PrimaryDiscount = { kind: 'none' };
  let discountError: string | undefined;
  if (member && (body.couponCode || body.pointsToUse || body.ticketId)) {
    const resolved = await resolvePrimaryDiscount(db, member.id, space.id, today, body.couponCode, body.pointsToUse, body.ticketId);
    if (resolved.error) discountError = resolved.error;
    else primary = resolved.primary;
  }

  // 該当するキャンペーンを解決（予約の全日程が対象の場合のみ適用）
  const resolvedCampaign = resolveCampaign(
    toCampaignCandidates(campaignRows),
    group.days.map((d) => ({ date: d.date, dayType: getDayType(d.date, holidayMap), price: d.price, seasonalPct: d.seasonalPct })),
    space.id,
  );

  const pointRate = Number(settings.get('point_rate') ?? '1');
  const totals = applyDiscounts({ days: group.days.map((d) => ({ billableHours: d.billableHours, price: d.price })), primary, campaign: resolvedCampaign?.rule, optionsTotal, pointRate });

  return c.json({
    spaceFee: totals.spaceFee,
    optionsTotal,
    primaryKind: totals.primaryKind,
    primaryDiscount: totals.primaryDiscount,
    couponHoursConsumed: totals.couponHoursConsumed,
    ticketHoursConsumed: totals.ticketHoursConsumed,
    pointsUsed: totals.pointsUsed,
    campaignDiscount: totals.campaignDiscount,
    campaignName: totals.campaignDiscount > 0 ? resolvedCampaign?.name ?? null : null,
    total: totals.total,
    pointsEarned: totals.pointsEarned,
    isMember: !!member,
    discountError,
    days: group.days.map((d) => ({ date: d.date, dayType: d.dayType, billingMode: d.billingMode, billableHours: d.billableHours, basePrice: d.basePrice, seasonalPct: d.seasonalPct, seasonalName: d.seasonalName, seasonalSurcharge: d.seasonalSurcharge, price: d.price, isResidence: d.isResidence, dayRateReason: d.dayRateReason, dayRateName: d.dayRateName })),
    optionLines,
    warnings,
  });
});

/**
 * POST /api/bookings/:number/cancel 予約キャンセル
 * ※会員ステータス別のセルフ可否・月間上限の判定は認証実装時に接続する。
 *   本エンドポイントはキャンセル処理とキャンセル料計算を行う。
 */
app.post('/:number/cancel', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (g.status === 'cancelled') return c.json({ error: '既にキャンセル済みです' }, 400);

  const bookings = (await getBookingsByGroup(db, g.id)).filter((b) => b.status !== 'cancelled');
  const policiesAll = await getCancelPolicies(db);
  const tiers: CancelPolicyTier[] = selectCancelPolicy(
    policiesAll.map((p) => ({
      spaceId: p.space_id,
      daysBefore: p.days_before,
      chargePct: p.charge_pct,
      cutoffTime: p.cutoff_time,
    })),
    g.space_id,
  );

  const now = nowJST();
  const today = now.slice(0, 10);

  // チケット払いの予約は現金キャンセル料¥0。前日以前は時間返還／当日は失効（返還なし）。
  const earliest = bookings.map((b) => b.date).sort()[0] || g.original_date || today;
  const ticketPlan = await buildTicketCancelPlan(db, g.id, earliest, today);

  let totalFee = 0;
  const stmts: D1PreparedStatement[] = [];
  const breakdown: Array<{ date: string; price: number; chargePct: number; cancelFee: number }> = [];

  for (const b of bookings) {
    const charge = computeCancelCharge(tiers, b.date, now, b.price);
    const chargePct = ticketPlan ? 0 : charge.chargePct;
    const cancelFee = ticketPlan ? 0 : charge.cancelFee; // チケット払いは¥0
    totalFee += cancelFee;
    breakdown.push({ date: b.date, price: b.price, chargePct, cancelFee });
    stmts.push(
      db
        .prepare(
          `INSERT INTO cancellation_log
           (id, group_id, booking_id, customer_id, cancelled_at, days_before, charge_pct, original_price, cancel_fee, collection_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .bind(
          crypto.randomUUID(),
          g.id,
          b.id,
          g.customer_id ?? '',
          now,
          daysBetween(today, b.date),
          chargePct,
          b.price,
          cancelFee,
        ),
    );
    stmts.push(db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(b.id));
  }
  stmts.push(db.prepare("UPDATE booking_groups SET status = 'cancelled' WHERE id = ?").bind(g.id));
  // 前日以前のチケット予約は、消費していたチケット時間を返還する。
  if (ticketPlan?.action === 'restore') stmts.push(...ticketPlan.restoreStmts);
  await db.batch(stmts);

  // キャンセル時は、この予約で使用したポイントを返還する（#78改）
  if (g.customer_id) await refundBookingPoints(db, g.id, g.customer_id, now);

  // Googleカレンダー（台帳の正）からイベント削除
  const cancelSpace = await getSpaceById(db, g.space_id);
  await deleteBookingFromCalendar(c.env, cancelSpace?.google_calendar_id ?? null, bookings.map((b) => b.google_event_id));

  // キャンセル確認メール（お客様宛。会員/ゲスト問わず customer_id があれば送信）＋管理者通知（#48）
  if (g.customer_id) {
    const [prof, sp] = await Promise.all([getCustomerProfile(db, g.customer_id), getSpaceById(db, g.space_id)]);
    const to = prof?.email ? String(prof.email) : '';
    const custName = prof?.contact_name ? String(prof.contact_name) : 'お客様';
    if (to) {
      const mail = cancellationEmail({ bookingNumber: number, spaceName: sp?.name ?? '', customerName: custName, cancelFee: totalFee });
      c.executionCtx.waitUntil(sendEmail(c.env, { to, ...mail }));
    }
    const admins = await adminRecipients(c.env, g.space_id);
    if (admins.length) {
      const adminMail = adminCancellationEmail({
        bookingNumber: number,
        spaceName: sp?.name ?? '',
        customerName: custName,
        customerEmail: to || undefined,
        customerPhone: prof?.phone ? String(prof.phone) : undefined,
        cancelFee: totalFee,
      });
      c.executionCtx.waitUntil(sendEmail(c.env, { to: admins, ...adminMail }));
      // 返金が生じる場合のみ、返金対応要アラートを発信（#63/#64）
      const paidAmount = g.payment_status === 'paid' ? g.total_amount : 0;
      const refundDue = Math.max(0, paidAmount - totalFee);
      if (refundDue > 0) {
        const alert = adminPaymentActionAlertEmail({
          kind: 'cancel',
          action: 'refund',
          amount: refundDue,
          bookingNumber: number,
          spaceName: sp?.name ?? '',
          customerName: custName,
          customerEmail: to || undefined,
          customerPhone: prof?.phone ? String(prof.phone) : undefined,
          paymentMethod: g.payment_method,
          paymentStatus: g.payment_status,
          cancelFee: totalFee,
          paidAmount,
          adminUrl: `${c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin}/admin.html?booking=${encodeURIComponent(number)}`,
        });
        c.executionCtx.waitUntil(sendEmail(c.env, { to: admins, ...alert }));
      }
    }
  }

  return c.json({
    bookingNumber: number,
    status: 'cancelled',
    cancelFee: totalFee,
    breakdown,
    ticket: ticketPlan ? { isTicket: true, action: ticketPlan.action, hours: ticketPlan.hours } : { isTicket: false },
    note: ticketPlan ? 'チケット予約のため現金キャンセル料は発生しません' : 'キャンセル料は管理者が手動で徴収します',
  });
});

/**
 * POST /api/bookings/:number/reschedule 日時変更
 * body: { items: [{date,startTime,endTime,isResidence?}] }
 * ※差額の決済/請求/返金ワークフロー(カード即時・請求書手動・返金)は
 *   決済・認証実装時に接続。本エンドポイントは日程更新と差額の記録を行う。
 */
app.post('/:number/reschedule', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  let body: { items?: Array<{ date: string; startTime: string; endTime: string; isResidence?: boolean }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: 'items は必須です' }, 400);
  }

  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (g.status === 'cancelled') return c.json({ error: 'キャンセル済みの予約は変更できません' }, 400);

  const space = await getSpaceById(db, g.space_id);
  if (!space || !space.is_active) return c.json({ error: 'space not found' }, 404);

  const settings = await getSystemSettings(db);
  const defaultDeadline = Number(settings.get('default_booking_deadline_days') ?? '0');
  const today = todayJST();
  const itemDates = body.items.map((i) => i.date).sort();
  const [holidays, seasonalRows] = await Promise.all([
    getHolidays(db, itemDates[0], itemDates[itemDates.length - 1]),
    getActiveSeasonalRulesForSpace(db, space.id),
  ]);
  const holidayMap = holidays as ReadonlyMap<string, HolidayType>;
  const seasonalRules: SeasonalRule[] = seasonalRows.map((r) => ({
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    surchargePct: r.surcharge_pct,
    dayRateOnly: !!r.day_rate_only,
  }));

  const valSpace = toValidationSpace(space);
  const errors: Array<{ index: number; code: string; message: string }> = [];
  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    const dayType = getDayType(item.date, holidayMap);
    const closures = await getSpaceClosures(db, space.id, item.date, item.date);
    const closed = isClosed(item.date, { holidays: holidayMap, spaceClosureDates: closures });
    for (const e of validateBookingItem(valSpace, item as BookingItemInput, {
      today,
      dayType,
      isClosed: closed,
      defaultDeadlineDays: defaultDeadline,
    })) {
      errors.push({ index: i, ...e });
    }
    // 競合（自グループを除く）
    const existing = await getOccupyingIntervalsExcludingGroup(db, space.id, item.date, g.id);
    if (existing.some((b) => intervalsOverlap(item.startTime, item.endTime, b.start_time, b.end_time))) {
      errors.push({ index: i, code: 'CONFLICT', message: `${item.date} ${item.startTime}-${item.endTime} は既に予約があります` });
    }
  }
  if (errors.length > 0) return c.json({ error: 'validation failed', details: errors }, 409);

  // 変更先の枠が Google カレンダー上で空いているか（自分自身のイベントは除外）
  const oldRows = await getBookingsByGroup(db, g.id);
  const calCheck = await checkCalendarConflictExcluding(
    c.env,
    space.google_calendar_id,
    body.items,
    oldRows.map((r) => r.google_event_id),
  );
  if (calCheck.conflict) {
    return c.json({ error: `${calCheck.conflict} はGoogleカレンダー上で埋まっています。別の時間をお選びください。`, code: 'CALENDAR_CONFLICT' }, 409);
  }

  // 新料金
  const dayInputs: DayBookingInput[] = body.items.map((i) => ({
    date: i.date,
    startTime: i.startTime,
    endTime: i.endTime,
    isResidence: i.isResidence,
  }));
  const newGroup = computeGroupSpacePrice(toPricingConfig(space), dayInputs, {
    holidays: holidayMap,
    seasonalRules,
  });

  // チケット払いの予約は、旧消費を戻して新しい日程で再充当する（#24）。
  const ticketUsage = await getTicketUsageForGroup(db, g.id);
  let ticketRecalc: { usageId: string; ticketId: string; newRemaining: number; newHours: number; coveredYen: number } | null = null;
  let newTotal: number;
  if (ticketUsage) {
    // チケット予約は「合計の利用時間数」を変更できない（日程・開始時刻の移動のみ）#24
    const oldHours = oldRows.reduce((s, r) => s + r.billable_hours, 0);
    const newHoursTotal = newGroup.days.reduce((s, d) => s + d.billableHours, 0);
    if (newHoursTotal !== oldHours) {
      return c.json(
        { error: 'チケットでご予約の場合、利用時間（合計時間数）は変更できません。日付・開始時刻の移動のみ可能です。時間数を変えたい場合は、一度キャンセルして取り直してください。', code: 'TICKET_DURATION_FIXED' },
        400,
      );
    }
    const restored = ticketUsage.remainingHours + ticketUsage.oldHours;
    const cov = coveredAmountForHours(
      newGroup.days.map((d) => ({ billableHours: d.billableHours, price: d.price })),
      restored,
    );
    newTotal = Math.max(0, newGroup.spaceTotal - cov.coveredYen);
    ticketRecalc = {
      usageId: ticketUsage.usageId,
      ticketId: ticketUsage.ticketId,
      newRemaining: restored - cov.coveredHours,
      newHours: cov.coveredHours,
      coveredYen: cov.coveredYen,
    };
  } else {
    newTotal = newGroup.spaceTotal;
  }
  const adjustment = computeAdjustment(g.total_amount, newTotal);

  // 日程を差し替え（旧bookingsを削除→新規挿入）+ グループ更新 + 差額記録
  const now = nowJST();
  const newBookingIds = body.items.map(() => crypto.randomUUID());
  const ticketStmts = ticketRecalc
    ? buildTicketRescheduleStmts(db, {
        usageId: ticketRecalc.usageId,
        ticketId: ticketRecalc.ticketId,
        newRemaining: ticketRecalc.newRemaining,
        newHours: ticketRecalc.newHours,
        spaceTotal: newGroup.spaceTotal,
        coveredYen: ticketRecalc.coveredYen,
        newFirstBookingId: newBookingIds[0],
        now,
      })
    : null;
  const stmts: D1PreparedStatement[] = [];
  // 旧 ticket_usage を先に削除してから旧 bookings を削除（FK 回避）
  if (ticketStmts) stmts.push(ticketStmts.clearOldUsage);
  stmts.push(db.prepare('DELETE FROM bookings WHERE group_id = ?').bind(g.id));
  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    const day = newGroup.days[i];
    stmts.push(
      db
        .prepare(
          `INSERT INTO bookings
           (id, group_id, space_id, date, start_time, end_time, billable_hours, billing_mode, is_residence, rate, price, status, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
        )
        .bind(
          newBookingIds[i],
          g.id,
          space.id,
          item.date,
          item.startTime,
          item.endTime,
          day.billableHours,
          day.billingMode,
          day.isResidence ? 1 : 0,
          day.rate,
          day.price,
          g.source,
        ),
    );
  }
  stmts.push(
    db
      .prepare('UPDATE booking_groups SET total_amount = ?, reschedule_count = reschedule_count + 1 WHERE id = ?')
      .bind(newTotal, g.id),
  );
  // チケット払いの予約：新 bookings 挿入後に残時間更新＋新 ticket_usage を挿入
  if (ticketStmts) stmts.push(...ticketStmts.applyNew);
  if (adjustment.type !== 'zero') {
    stmts.push(
      db
        .prepare(
          `INSERT INTO booking_adjustments (id, group_id, type, amount, payment_method, status, created_at)
           VALUES (?, ?, ?, ?, 'invoice', 'pending', ?)`,
        )
        .bind(crypto.randomUUID(), g.id, adjustment.type, adjustment.amount, now),
    );
  }
  await db.batch(stmts);

  const cust = g.customer_id ? await getCustomerProfile(db, g.customer_id) : null;
  const custName = cust?.contact_name ? String(cust.contact_name) : (g.event_name || 'お客様');

  // Googleカレンダー同期：旧イベントを削除し、新しい日時でリッチ内容を作り直す（#54関連）
  let calendarWarning: string | null = null;
  if (space.google_calendar_id) {
    await deleteBookingFromCalendar(c.env, space.google_calendar_id, oldRows.map((r) => r.google_event_id));
    const rsOrigin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
    const res = await syncBookingCalendarEvents(c.env, g.id, rsOrigin);
    calendarWarning = res.warning ?? null;
  }

  // 変更通知メール（お客様＋管理者）。商談中は金額を伏せる。
  const oldDays = oldRows.map((r) => ({ date: r.date, startTime: r.start_time, endTime: r.end_time }));
  const newDays = body.items.map((i) => ({ date: i.date, startTime: i.startTime, endTime: i.endTime }));
  const mailData = {
    bookingNumber: number,
    spaceName: space.name,
    eventName: g.event_name,
    customerName: custName,
    oldDays,
    newDays,
    total: newTotal,
    oldTotal: g.total_amount,
    status: g.status as 'confirmed' | 'tentative',
    showAmount: g.status !== 'tentative',
  };
  const custEmail = cust?.email ? String(cust.email) : '';
  if (custEmail) {
    c.executionCtx.waitUntil(sendEmail(c.env, { to: custEmail, ...rescheduleEmail(mailData) }));
  }
  const rsAdmins = await adminRecipients(c.env, space.id);
  if (rsAdmins.length) {
    const adminMail = adminRescheduleEmail({ ...mailData, customerEmail: custEmail || undefined, customerPhone: cust?.phone ? String(cust.phone) : undefined });
    c.executionCtx.waitUntil(sendEmail(c.env, { to: rsAdmins, ...adminMail }));
    // 料金変更（差額）が出た場合のみ、返金/追加請求の対応要アラートを発信（#62/#64）
    if (adjustment.type !== 'zero') {
      const alert = adminPaymentActionAlertEmail({
        kind: 'reschedule',
        action: adjustment.type === 'surcharge' ? 'surcharge' : 'refund',
        amount: adjustment.amount,
        bookingNumber: number,
        spaceName: space.name,
        customerName: custName,
        customerEmail: custEmail || undefined,
        customerPhone: cust?.phone ? String(cust.phone) : undefined,
        paymentMethod: g.payment_method,
        paymentStatus: g.payment_status,
        oldTotal: g.total_amount,
        newTotal,
        adminUrl: `${c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin}/admin.html?booking=${encodeURIComponent(number)}`,
      });
      c.executionCtx.waitUntil(sendEmail(c.env, { to: rsAdmins, ...alert }));
    }
  }

  return c.json({
    bookingNumber: number,
    newTotal,
    adjustment,
    days: newGroup.days.map((d) => ({ date: d.date, billingMode: d.billingMode, price: d.price })),
    calendarWarning,
  });
});

/**
 * POST /api/bookings/:number/options オプション変更（全日程共通）
 * body: { options: [{optionId, quantity?}] }  ※既存のオプションを置き換える
 */
app.post('/:number/options', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  let body: { options?: Array<{ optionId: string; quantity?: number }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const reqOptions = body.options ?? [];

  const g = await getBookingGroupByNumber(db, number);
  if (!g) return c.json({ error: 'booking not found' }, 404);
  if (g.status === 'cancelled') return c.json({ error: 'キャンセル済みの予約は変更できません' }, 400);

  const groupBookings = await getBookingsByGroup(db, g.id);
  const dates = [...new Set(groupBookings.map((b) => b.date))];

  // 現在のオプション小計合計
  const curRow = await db
    .prepare('SELECT COALESCE(SUM(subtotal),0) AS t FROM booking_option_selections WHERE group_id = ?')
    .bind(g.id)
    .first<{ t: number }>();
  const currentOptionsTotal = curRow?.t ?? 0;
  const spaceFee = g.total_amount - currentOptionsTotal;

  // 新オプションを検証・在庫確認（自グループ除外）
  const newSelections: Array<{ optionId: string; quantity: number; subtotal: number }> = [];
  let newOptionsTotal = 0;
  if (reqOptions.length > 0) {
    const optMap = await getOptionsByIds(db, reqOptions.map((o) => o.optionId));
    for (const req of reqOptions) {
      const opt = optMap.get(req.optionId);
      if (!opt || !opt.is_active) return c.json({ error: `オプションが見つかりません: ${req.optionId}` }, 400);
      if (!(await isOptionAvailableForSpace(db, g.space_id, opt.id))) {
        return c.json({ error: `${opt.name} はこのスペースで利用できません` }, 400);
      }
      const norm = normalizeQuantity(
        { id: opt.id, type: opt.type, priceType: opt.price_type, unitPrice: opt.unit_price, maxQty: opt.max_qty, stockTotal: opt.stock_total },
        req.quantity ?? 1,
      );
      if (norm.error) return c.json({ error: `${opt.name}: ${norm.error}` }, 400);
      for (const date of dates) {
        const used = await getDailyOptionUsage(db, opt.id, date, g.id); // 自グループ除外
        if (!hasStock(opt.stock_total, used, norm.quantity)) {
          return c.json({ error: `${opt.name} は ${date} の在庫が不足しています（残${Math.max(0, (opt.stock_total ?? 0) - used)}）` }, 409);
        }
      }
      const subtotal = optionSubtotal(opt.price_type, opt.unit_price, norm.quantity);
      newSelections.push({ optionId: opt.id, quantity: norm.quantity, subtotal });
      newOptionsTotal += subtotal;
    }
  }

  const newTotal = spaceFee + newOptionsTotal;
  const adjustment = computeAdjustment(g.total_amount, newTotal);
  const now = nowJST();

  const stmts: D1PreparedStatement[] = [];
  stmts.push(db.prepare('DELETE FROM booking_option_selections WHERE group_id = ?').bind(g.id));
  for (const sel of newSelections) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO booking_option_selections (id, group_id, option_id, quantity, subtotal)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), g.id, sel.optionId, sel.quantity, sel.subtotal),
    );
  }
  stmts.push(db.prepare('UPDATE booking_groups SET total_amount = ? WHERE id = ?').bind(newTotal, g.id));
  if (adjustment.type !== 'zero') {
    stmts.push(
      db
        .prepare(
          `INSERT INTO booking_adjustments (id, group_id, type, amount, payment_method, status, created_at)
           VALUES (?, ?, ?, ?, 'invoice', 'pending', ?)`,
        )
        .bind(crypto.randomUUID(), g.id, adjustment.type, adjustment.amount, now),
    );
  }
  await db.batch(stmts);

  return c.json({ bookingNumber: number, spaceFee, optionsTotal: newOptionsTotal, newTotal, adjustment });
});

// 旧・無認証の変更リクエスト受付は廃止（#75）。ゲストは POST /api/guest-change/request
// （メール＋電話＋予約番号の3点照合）を、会員は POST /api/mypage/... を使用する。

/** GET /api/bookings/:number 予約取得（番号指定） */
app.get('/:number', async (c) => {
  const db = c.env.DB;
  const number = c.req.param('number');
  const g = await db
    .prepare(
      `SELECT id, booking_number, space_id, event_name, total_amount, status, created_at
       FROM booking_groups WHERE booking_number = ?`,
    )
    .bind(number)
    .first<{
      id: string;
      booking_number: string;
      space_id: string;
      event_name: string;
      total_amount: number;
      status: string;
      created_at: string;
    }>();
  if (!g) return c.json({ error: 'booking not found' }, 404);

  const { results: days } = await db
    .prepare(
      `SELECT date, start_time, end_time, billable_hours, billing_mode, is_residence, price, status
       FROM bookings WHERE group_id = ? ORDER BY date, start_time`,
    )
    .bind(g.id)
    .all();

  return c.json({
    bookingNumber: g.booking_number,
    spaceId: g.space_id,
    eventName: g.event_name,
    total: g.total_amount,
    status: g.status,
    createdAt: g.created_at,
    days,
  });
});

export default app;
