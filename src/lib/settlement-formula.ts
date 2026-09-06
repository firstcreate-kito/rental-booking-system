/**
 * キャンセル料・日時変更の「計算式（内訳）」を組み立てる共有ヘルパー。
 * マイページのモーダル表示（GET /cancel-quote・/reschedule-quote の formula）と
 * 申込時メール（顧客・管理者）で**同一の文言**を使うための単一の出所。
 *
 * 金額の算出そのものは cancellation.ts / change-settlement.ts が正。ここは表示・説明専用。
 */

const yen = (n: number): string => '¥' + Math.round(n).toLocaleString('ja-JP');

export interface CancelFormulaInput {
  spaceName: string;
  daysBefore: number | null; // 当初利用日までの残日数
  chargePctMax: number; // 適用キャンセル料率（%）
  cancelFee: number; // キャンセル料（合計）
  paidAmount: number; // 入金済み金額（未入金は0）
  refundAmount: number; // ご返金額
  totalAmount: number; // 予約合計
  breakdown: ReadonlyArray<{ date: string; price: number; chargePct: number; cancelFee: number }>;
  ticket?: { isTicket: boolean; action?: string; hours?: number | null };
}

/** キャンセル料・返金の計算式（1行=1要素） */
export function cancelFormulaLines(d: CancelFormulaInput): string[] {
  if (d.ticket?.isTicket) {
    const hrs = d.ticket.hours != null ? `${d.ticket.hours}時間` : 'チケット時間';
    return d.ticket.action === 'restore'
      ? ['【チケット（回数券）でのご予約】', '・現金のキャンセル料・ご返金：なし（¥0）', `・前々日までのキャンセルのため、${hrs}を返還（再予約にご利用いただけます）`]
      : ['【チケット（回数券）でのご予約】', '・現金のキャンセル料・ご返金：なし（¥0）', `・前日・当日のキャンセルのため、${hrs}は失効（返還なし）`];
  }
  const period = d.daysBefore != null ? `ご利用日の${d.daysBefore}日前` : 'ご利用日基準';
  const lines: string[] = ['【キャンセル料の計算】'];
  if (d.breakdown.length <= 1) {
    const price = d.breakdown[0]?.price ?? d.totalAmount;
    lines.push(`・対象金額：${yen(price)}`);
    lines.push(`・キャンセル料率：${d.chargePctMax}%（${period}・${d.spaceName}）`);
    lines.push(`・キャンセル料：${yen(price)} × ${d.chargePctMax}% = ${yen(d.cancelFee)}`);
  } else {
    lines.push(`・キャンセル料率：${period}・${d.spaceName}`);
    for (const b of d.breakdown) lines.push(`　- ${b.date}：${yen(b.price)} × ${b.chargePct}% = ${yen(b.cancelFee)}`);
    lines.push(`・キャンセル料 合計：${yen(d.cancelFee)}`);
  }
  if (d.paidAmount > 0) {
    lines.push(`・ご返金額：お支払い ${yen(d.paidAmount)} − キャンセル料 ${yen(d.cancelFee)} = ${yen(d.refundAmount)}`);
  } else {
    lines.push('・ご返金額：お支払い前のため なし（¥0）');
  }
  return lines;
}

export interface RescheduleFormulaInput {
  spaceName: string;
  kind: 'move' | 'increase' | 'decrease' | 'cancel_treatment';
  currentTotal: number; // 変更前の料金
  newTotal: number; // 変更後の料金
  cancelChargePct: number; // 当初利用日基準のキャンセル料率（減額按分・キャンセル扱い判定）
  refund: number; // ご返金額（減額時）
  charge: number; // 追加請求額（増額）／新予約満額（キャンセル扱い）
  ticket?: boolean; // チケット予約
}

/** 日時変更の返金/追加請求/キャンセル扱いの計算式（1行=1要素） */
export function rescheduleFormulaLines(d: RescheduleFormulaInput): string[] {
  if (d.ticket) return ['【チケット（回数券）でのご予約】', '・日時の移動による現金の精算：なし（¥0）'];
  if (d.kind === 'cancel_treatment') {
    return [
      '【この日時変更は「キャンセル扱い」です】',
      '・直前のご変更のため、元のご予約は返金なし（¥0）',
      `・新しいご予約：満額 ${yen(d.charge)}`,
    ];
  }
  if (d.kind === 'increase') {
    return [
      '【日時変更の差額（増額）】',
      `・変更前の料金：${yen(d.currentTotal)}`,
      `・変更後の料金：${yen(d.newTotal)}`,
      `・追加のお支払い：${yen(d.newTotal)} − ${yen(d.currentTotal)} = ${yen(d.charge)}`,
    ];
  }
  if (d.kind === 'decrease') {
    const reduced = Math.max(0, d.currentTotal - d.newTotal);
    const lines = [
      '【日時変更のご返金（減額）】',
      `・変更前の料金：${yen(d.currentTotal)}`,
      `・変更後の料金：${yen(d.newTotal)}`,
      `・短縮分：${yen(d.currentTotal)} − ${yen(d.newTotal)} = ${yen(reduced)}`,
    ];
    if (d.cancelChargePct > 0) {
      lines.push(`・キャンセル料率：${d.cancelChargePct}%（短縮分は「一部キャンセル」扱い）`);
      lines.push(`・ご返金：${yen(reduced)} × (100 − ${d.cancelChargePct})% = ${yen(d.refund)}`);
    } else {
      lines.push(`・ご返金：短縮分を全額返金 ${yen(d.refund)}`);
    }
    return lines;
  }
  return ['【日時変更】', '・同じ時間数のため料金の変更はありません（無償）'];
}
