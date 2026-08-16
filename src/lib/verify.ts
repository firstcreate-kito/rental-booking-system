/**
 * ゲスト予約の本人確認（#75）。
 * メール＋電話＋予約番号の3点完全一致で照合する。表記ゆれ（大文字小文字・全角・ハイフン）
 * を吸収して比較するための正規化を提供する。純粋関数（テスト可能）。
 */

/** メール正規化：前後空白除去＋小文字化 */
export function normalizeEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** 電話正規化：全角数字→半角、数字以外を除去（ハイフン有無・全角を吸収） */
export function normalizePhone(s: string | null | undefined): string {
  const half = (s ?? '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  return half.replace(/[^0-9]/g, '');
}

/**
 * 入力（email/phone）と保存済みの顧客連絡先が一致するか。
 * 予約番号の一致は呼び出し側でグループを引く時点で担保する前提。
 * 空文字同士の“空一致”は不可（未入力を弾く）。
 */
export function guestContactMatches(
  input: { email: string; phone: string },
  stored: { email?: string | null; phone?: string | null },
): boolean {
  const ie = normalizeEmail(input.email);
  const ip = normalizePhone(input.phone);
  if (!ie || !ip) return false;
  return ie === normalizeEmail(stored.email) && ip === normalizePhone(stored.phone);
}
