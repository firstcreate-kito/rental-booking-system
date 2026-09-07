/**
 * 返金時の決済手数料控除（カード／PayPal）。
 *
 * キャンセル・日時変更で返金が発生する際、クレジットカード（stripe）・PayPal 決済は
 * 決済代行会社の手数料が返らないため、返金額から決済手数料（REFUND_FEE_PCT％・切り上げ）を
 * 差し引いた金額をお客様へ返金する。銀行振込・コンビニ・請求書払い（invoice）は
 * 決済代行手数料が発生しないため手数料控除なし（全額返金）。
 *
 * オーナー合意（2026-09-07）：
 *   - 対象＝カード（stripe）＋PayPal
 *   - 基準＝ご返金額に対して REFUND_FEE_PCT％（決済手数料）＋ 同手数料への消費税 REFUND_FEE_TAX_PCT％
 *     → 実効率 = REFUND_FEE_PCT × (1 + REFUND_FEE_TAX_PCT/100)（3.7% × 1.10 ＝ 4.07%）
 *   - 端数＝切り上げ（Math.ceil・税込合計で1円単位に切り上げ）
 * 表示・保存・メールの返金額は net（控除後）を用い、内訳（settlement-formula）に控除行と説明を出す。
 *
 * ※このモジュールは docs/unified-change-cancel-policy.md の保護対象。料率・対象・丸めの変更は
 *   test/policy-lock.test.ts が値で固定している。安易に変えず、まずオーナーへ確認する。
 */

/** 決済手数料率（%表記・税抜）。返金額に対して差し引く。 */
export const REFUND_FEE_PCT = 3.7;

/** 決済手数料に上乗せする消費税率（%）。 */
export const REFUND_FEE_TAX_PCT = 10;

/** 手数料控除の対象となる決済方法（決済代行手数料が返らないもの）。 */
const FEE_METHODS: ReadonlySet<string> = new Set(['stripe', 'paypal']);

export interface RefundFee {
  /** 手数料控除前のご返金額（ポリシー算出額） */
  gross: number;
  /** 差し引く決済手数料（消費税込・切り上げ） */
  fee: number;
  /** 実際にお客様へ返金する額（gross − fee・0以上） */
  net: number;
  /** 手数料を差し引いたか（対象決済かつ fee>0） */
  applied: boolean;
  /** 決済手数料率（%・税抜） */
  pct: number;
  /** 決済手数料への消費税率（%） */
  taxPct: number;
}

/**
 * 返金額に決済手数料（税込）を適用する。
 * fee ＝ ⌈ gross × pct% ×（1 + 消費税%）⌉（税込合計を1円単位に切り上げ）。
 * 対象外の決済方法・返金0円以下のときは gross をそのまま net として返す（applied=false）。
 */
export function applyRefundFee(gross: number, paymentMethod: string | null | undefined): RefundFee {
  const eligible = FEE_METHODS.has(String(paymentMethod ?? ''));
  if (!eligible || !(gross > 0)) {
    return { gross, fee: 0, net: gross, applied: false, pct: REFUND_FEE_PCT, taxPct: REFUND_FEE_TAX_PCT };
  }
  // 実効額 ＝ 返金額 × 手数料率% ×（1＋消費税率%）。
  // 浮動小数の誤差（例 407.00000000000006）で切り上げが1円ずれないよう、6桁で丸めてから切り上げる。
  const raw = (gross * REFUND_FEE_PCT) / 100 * (1 + REFUND_FEE_TAX_PCT / 100);
  const fee = Math.ceil(Number(raw.toFixed(6)));
  const net = Math.max(0, gross - fee);
  return { gross, fee, net, applied: true, pct: REFUND_FEE_PCT, taxPct: REFUND_FEE_TAX_PCT };
}
