/**
 * 日時変更・増減の「精算額」計算（統一ポリシー §2）。純粋関数（DB非依存）。
 * docs/unified-change-cancel-policy.md
 *
 * 設計のキモ：「キャンセル扱いの時期」＝そのスペースの**キャンセル料が100%になる時期**、と定義する。
 *   - 標準スペース … 当日が100%       → 当日の変更はキャンセル扱い
 *   - 防音室A・B／東別院 … 前日・当日が100% → 当日・前日の変更はキャンセル扱い
 *   これにより「標準＝当日／防音室＝当日・前日」がスペース別に自動で一致する（別途フラグ不要）。
 *
 * 呼び出し側は、変更申込日(today)基準の当初利用日までの残日数に対応する
 *   「キャンセル料率（%）」を computeCancelCharge から求めて cancelChargePct として渡す。
 *
 * ※金額は最終的に管理者が承認画面で任意に調整できる（本関数の値はプリセット＝目安）。
 */

export type ChangeSettlementKind = 'move' | 'increase' | 'decrease' | 'cancel_treatment';

export interface ChangeSettlement {
  kind: ChangeSettlementKind;
  /** お客様への返金額（円・0以上） */
  refund: number;
  /** お客様への追加請求額（円・0以上） */
  charge: number;
  /** 表示用の補足 */
  note: string;
}

/**
 * @param originalTotal 当初予約金額（スペース料金・税込）
 * @param newTotal 変更後の予約金額
 * @param cancelChargePct 変更申込日における当該スペースのキャンセル料率（0〜100）
 */
export function computeChangeSettlement(
  originalTotal: number,
  newTotal: number,
  cancelChargePct: number,
): ChangeSettlement {
  // キャンセル扱いの時期（キャンセル料100%）：旧予約は返金なし・新予約は満額請求。
  if (cancelChargePct >= 100) {
    return {
      kind: 'cancel_treatment',
      refund: 0,
      charge: Math.max(0, newTotal),
      note: '当日・前日の変更はキャンセル扱いです（旧予約は返金なし・新しい予約は満額）。',
    };
  }
  if (newTotal > originalTotal) {
    return { kind: 'increase', refund: 0, charge: newTotal - originalTotal, note: '時間追加分の差額を追加請求します。' };
  }
  if (newTotal < originalTotal) {
    // 減額：減った分を「一部キャンセル」とみなし、キャンセル料率で按分して返金。
    const reduced = originalTotal - newTotal;
    const refund = Math.round((reduced * (100 - cancelChargePct)) / 100);
    const pctNote = cancelChargePct > 0 ? `（減少分の${cancelChargePct}%はキャンセル料）` : '';
    return { kind: 'decrease', refund, charge: 0, note: `短縮分を返金します${pctNote}。` };
  }
  return { kind: 'move', refund: 0, charge: 0, note: '料金の変更はありません（無償でお日にち・時間を変更）。' };
}
