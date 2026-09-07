/**
 * 返金時の手数料控除（決済方法で分岐）。
 *
 * キャンセル・日時変更（減額）で返金が発生する際、返金額から手数料を差し引いた金額を
 * お客様へ返金する。手数料は決済方法により2種類：
 *   - カード（stripe）／PayPal … 決済代行手数料が返らないため「返金額 × REFUND_FEE_PCT％」（率）。
 *   - 銀行振込／コンビニ／請求書払い … 返金の振込に一律 REFUND_TRANSFER_FEE 円（定額）。
 * いずれも消費税 REFUND_FEE_TAX_PCT％ を上乗せし、税込合計を1円単位で切り上げる。
 *
 * オーナー合意：
 *   - カード／PayPal ＝ 3.7%＋消費税10%（実効4.07%・切り上げ）／2026-09-07
 *   - 振込・コンビニ・請求書払い ＝ 一律¥350＋消費税10%（＝¥385）／2026-09-07
 * 表示・保存・メールの返金額は net（控除後）を用い、内訳（settlement-formula）に控除行と説明を出す。
 *
 * ※このモジュールは docs/unified-change-cancel-policy.md の保護対象。料率・定額・対象・丸めの変更は
 *   test/policy-lock.test.ts が値で固定している。安易に変えず、まずオーナーへ確認する。
 */

/** カード／PayPal の決済手数料率（%表記・税抜）。返金額に対して差し引く。 */
export const REFUND_FEE_PCT = 3.7;

/** 手数料に上乗せする消費税率（%）。 */
export const REFUND_FEE_TAX_PCT = 10;

/** 銀行振込／コンビニ／請求書払いの一律返金手数料（円・税抜）。 */
export const REFUND_TRANSFER_FEE = 350;

/** 手数料の種類（表示分岐用）。'card'＝率、'transfer'＝定額。 */
export type RefundFeeKind = 'card' | 'transfer';

/** 率で控除する決済方法（決済代行手数料が返らないもの）。 */
const RATE_METHODS: ReadonlySet<string> = new Set(['stripe', 'paypal']);
/** 定額で控除する決済方法（返金の振込手数料）。 */
const FLAT_METHODS: ReadonlySet<string> = new Set(['bank_transfer', 'konbini', 'invoice']);

/** 浮動小数の誤差（例 385.00000000000006）で切り上げが1円ずれないよう6桁で丸めてから切り上げる。 */
const ceilYen = (n: number): number => Math.ceil(Number(n.toFixed(6)));

export interface RefundFee {
  /** 手数料控除前のご返金額（ポリシー算出額） */
  gross: number;
  /** 差し引く手数料（消費税込・切り上げ） */
  fee: number;
  /** 実際にお客様へ返金する額（gross − fee・0以上） */
  net: number;
  /** 手数料を差し引いたか（対象決済かつ fee>0） */
  applied: boolean;
  /** 手数料の種類（'card'＝率／'transfer'＝定額。対象外は null） */
  kind: RefundFeeKind | null;
  /** カード／PayPal の決済手数料率（%・税抜） */
  pct: number;
  /** 手数料への消費税率（%） */
  taxPct: number;
  /** 振込・コンビニ・請求書払いの一律手数料（円・税抜） */
  flatBase: number;
}

/**
 * 返金額に手数料（税込）を適用する。
 * 対象外の決済方法・返金0円以下のときは gross をそのまま net として返す（applied=false）。
 */
export function applyRefundFee(gross: number, paymentMethod: string | null | undefined): RefundFee {
  const m = String(paymentMethod ?? '');
  const base: RefundFee = {
    gross, fee: 0, net: gross, applied: false, kind: null,
    pct: REFUND_FEE_PCT, taxPct: REFUND_FEE_TAX_PCT, flatBase: REFUND_TRANSFER_FEE,
  };
  if (!(gross > 0)) return base;
  const tax = 1 + REFUND_FEE_TAX_PCT / 100;
  // 手数料が返金額を上回るレアケース（少額返金 × 定額手数料など）は、返金額を上限に控除し、
  // ご返金額は 0円 とする（マイナス返金にはしない）。表示上も「返金額まで控除→¥0」と読める。
  if (RATE_METHODS.has(m)) {
    const fee = Math.min(gross, ceilYen((gross * REFUND_FEE_PCT) / 100 * tax));
    return { ...base, fee, net: gross - fee, applied: true, kind: 'card' };
  }
  if (FLAT_METHODS.has(m)) {
    const fee = Math.min(gross, ceilYen(REFUND_TRANSFER_FEE * tax)); // 350 × 1.10 = 385
    return { ...base, fee, net: gross - fee, applied: true, kind: 'transfer' };
  }
  return base;
}
