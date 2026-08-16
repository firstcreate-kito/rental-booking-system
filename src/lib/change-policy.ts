/**
 * 予約変更・キャンセルポリシーの可否判定（#76 Phase 1）
 *
 * 仕様: docs/change-cancel-policy-spec.md
 *
 * 判定はすべて「当初予約」を基準にする:
 *   - daysBefore   … 当初利用日 − 本日（暦日・前日=1・当日=0・経過=負）
 *   - originalTotal … 当初予約金額（作成時の合計）
 *   - newTotal      … 変更後の合計（減額判定・当初金額に対する累計で見る）
 *
 * このモジュールは純粋関数のみ。DB や現在時刻に依存しない（呼び出し側で値を用意する）。
 *
 * Phase 1 の方針:
 *   - 減額・日程変更は「範囲内/超過の判定＋文言表示」まで。セルフ確定は新設しない。
 *   - セルフキャンセルのみ 3日前ラインで実際にゲートする（会員マイページ）。
 *   - 範囲超過・停止ラインの内側は「メールフォーム誘導」に切り替える。
 *   - 手数料・返金の金額計算はしない（人が処理）。
 */
import { daysBetween } from './calendar';

export type ChangeOperation = 'increase' | 'decrease' | 'reschedule' | 'cancel';

/** 'self' = オンラインで手続き可 / 'form' = メールフォームへ誘導 */
export type ChangeMode = 'self' | 'form';

export interface ChangePolicyResult {
  /** セルフ操作（オンライン手続き）を許可してよいか */
  allowed: boolean;
  mode: ChangeMode;
  /** 判定理由・お客様向け文言 */
  message: string;
}

/** セルフキャンセルの受付停止ライン。3日前以降（当日含む）はフォーム誘導。 */
export const SELF_CANCEL_MIN_DAYS_BEFORE = 4;

/** 日程変更の無償セルフ振替が可能な残日数（これ以上前ならセルフ振替の対象）。 */
export const RESCHEDULE_SELF_MIN_DAYS_BEFORE = 31;

/** 日程変更の振替可能幅（当初利用日の前後）。単位=月。 */
export const RESCHEDULE_WINDOW_MONTHS = 1;

const FORM_MESSAGE =
  'この内容はオンラインでのお手続き範囲を超えています。キャンセル料が発生する場合がございますので、お手続き前に担当者より金額をご案内します。お手数ですがメールフォームよりご連絡ください。';

/**
 * 当初利用日までの残日数（暦日）を求める。
 * 前日=1・当日=0・経過後は負。
 */
export function leadDays(originalDate: string, today: string): number {
  return daysBetween(today, originalDate);
}

/**
 * 減額（時間短縮・日数削減）で無償セルフ操作が許される「最低残存割合」を返す。
 *   31日以前 → 0（制限なし）
 *   30〜15日前 → 0.5（当初の50%以上残す）
 *   14日前〜前日 → 0.8（当初の80%以上残す）
 *   当日以降 → 1（減額不可＝当初金額を維持しない限り不可）
 */
export function minRemainRatioForDecrease(daysBefore: number): number {
  if (daysBefore >= 31) return 0;
  if (daysBefore >= 15) return 0.5;
  if (daysBefore >= 1) return 0.8;
  return 1;
}

/** 当初利用日の前後 months ヶ月の範囲 [from, to]（両端含む）を返す。 */
export function rescheduleWindow(originalDate: string, months: number): { from: string; to: string } {
  const shift = (iso: string, deltaMonths: number): string => {
    const [y, m, d] = iso.split('-').map(Number);
    const base = new Date(Date.UTC(y, m - 1, d));
    base.setUTCMonth(base.getUTCMonth() + deltaMonths);
    // 月末調整で日付が繰り上がった場合（例: 1/31 + 1ヶ月）は対象月の末日に丸める
    if (base.getUTCDate() !== d) base.setUTCDate(0);
    const yy = base.getUTCFullYear();
    const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(base.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  };
  return { from: shift(originalDate, -months), to: shift(originalDate, months) };
}

/** キャンセルをオンラインで受け付けてよいか（3日前以降はフォーム誘導）。 */
export function evaluateCancel(daysBefore: number): ChangePolicyResult {
  if (daysBefore >= SELF_CANCEL_MIN_DAYS_BEFORE) {
    return { allowed: true, mode: 'self', message: '' };
  }
  const msg =
    daysBefore <= 0
      ? '当日のオンラインキャンセルは承っておりません。お手数ですがお電話・メールフォームよりご連絡ください。'
      : '利用日の3日前以降は、オンラインでのキャンセルを承っておりません。キャンセル料が発生する場合は手続き前に担当者より金額をご案内します。お手数ですがメールフォームよりご連絡ください。';
  return { allowed: false, mode: 'form', message: msg };
}

/** 減額がオンライン手続きの範囲内か（当初金額に対する累計で判定）。 */
export function evaluateDecrease(daysBefore: number, originalTotal: number, newTotal: number): ChangePolicyResult {
  // 増額・据え置きは減額判定の対象外（常に範囲内）
  if (newTotal >= originalTotal) return { allowed: true, mode: 'self', message: '' };
  if (daysBefore <= 0) {
    return {
      allowed: false,
      mode: 'form',
      message: '当日のご利用時間の短縮はキャンセル扱いとなり、オンラインでは承れません。お手数ですがメールフォームよりご連絡ください。',
    };
  }
  const ratio = minRemainRatioForDecrease(daysBefore);
  const floor = Math.ceil(originalTotal * ratio);
  if (newTotal >= floor) return { allowed: true, mode: 'self', message: '' };
  const pct = Math.round(ratio * 100);
  return {
    allowed: false,
    mode: 'form',
    message: `ご利用日が近いため、当初ご予約金額の${pct}%以上を残すご変更のみオンラインで承れます。この範囲を超える減額は、減少分にキャンセル料が発生する場合があります。${FORM_MESSAGE}`,
  };
}

/** 日程変更がオンライン手続きの範囲内か（31日前は当初日±1ヶ月、30日前以降はフォーム）。 */
export function evaluateReschedule(daysBefore: number, originalDate: string, newDate: string): ChangePolicyResult {
  if (daysBefore < RESCHEDULE_SELF_MIN_DAYS_BEFORE) {
    return {
      allowed: false,
      mode: 'form',
      message: '利用日の30日前以降の日程変更は、キャンセル＋新規のお取り扱いとなります。お手数ですがメールフォームよりご連絡ください。',
    };
  }
  const { from, to } = rescheduleWindow(originalDate, RESCHEDULE_WINDOW_MONTHS);
  if (newDate >= from && newDate <= to) return { allowed: true, mode: 'self', message: '' };
  return {
    allowed: false,
    mode: 'form',
    message: `無償でのお振替は当初ご予定日（${originalDate}）の前後1ヶ月以内（${from}〜${to}）に限ります。この範囲外へのご変更はメールフォームよりご連絡ください。`,
  };
}

/**
 * 操作種別に応じた統合判定。呼び出し側は daysBefore を leadDays() で用意する。
 * increase は常に許可（空き判定は別途）。
 */
export function evaluateChange(input: {
  operation: ChangeOperation;
  daysBefore: number;
  originalTotal?: number;
  newTotal?: number;
  originalDate?: string;
  newDate?: string;
}): ChangePolicyResult {
  switch (input.operation) {
    case 'increase':
      return { allowed: true, mode: 'self', message: '' };
    case 'cancel':
      return evaluateCancel(input.daysBefore);
    case 'decrease':
      return evaluateDecrease(input.daysBefore, input.originalTotal ?? 0, input.newTotal ?? 0);
    case 'reschedule':
      return evaluateReschedule(input.daysBefore, input.originalDate ?? '', input.newDate ?? '');
    default:
      return { allowed: false, mode: 'form', message: FORM_MESSAGE };
  }
}
