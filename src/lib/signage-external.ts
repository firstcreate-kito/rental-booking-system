/**
 * サイネージ：外部プラットフォーム（スペースマーケット／インスタベース等）予約の表示名抽出（#124拡張）。
 *
 * これらの予約は各社→Googleカレンダーに連携され、部屋のカレンダーに「予定」として載る。
 * 予定タイトルに氏名（姓 名＋様）が入っているため、そこから「姓＋様」だけを取り出して表示する。
 * 公開ページのため、フルネーム・下の名前・予約IDなどは出さない（自社予約と同じ「姓 様」に統一）。
 *
 * 実例（Googleカレンダーの予定タイトル）：
 *  - インスタベース：「【インスタベース】予約確定 - 若山 南沙様 (予約ID: 4158942198)」→「若山 様」
 *  - スペースマーケット：「【予約完了】小野 奈津佳 様(スペースマーケット予約 ID:5963333)」→「小野 様」
 */

const SPACEMARKET = 'スペースマーケット';
const INSTABASE = 'インスタベース';

/** タイトルから出どころ（プラットフォーム名）を推定。分からなければ null。 */
export function detectExternalSource(summary: string): string | null {
  const s = String(summary ?? '');
  if (s.includes(SPACEMARKET)) return SPACEMARKET;
  if (s.includes(INSTABASE) || s.toLowerCase().includes('instabase')) return INSTABASE;
  return null;
}

export interface ExternalParsed {
  label: string; // サイネージ表示名（「姓 様」等）
  source: string | null; // 出どころ（スペースマーケット／インスタベース／null）
}

/**
 * 外部予約のGoogleカレンダー予定タイトルから、サイネージ表示名を作る。
 * - タイトル内の「…様」の直前の氏名を取り出し、姓（先頭トークン）＋「 様」にする。
 * - 氏名が取れない場合は「<出どころ>予約」、出どころ不明なら「予約あり」。
 */
export function parseExternalDisplayName(summary: string): ExternalParsed {
  const s = String(summary ?? '').trim();
  const source = detectExternalSource(s);
  // 「様」の直前の氏名（内部の空白は許可／括弧・ハイフン・角括弧は跨がない）を抽出
  const m = s.match(/([^\s　【】()（）\-–—‐－―]+(?:[\s　]+[^\s　【】()（）\-–—‐－―]+)*)\s*様/);
  if (m && m[1]) {
    const last = m[1].trim().split(/[\s　]+/).filter(Boolean)[0];
    if (last) return { label: `${last} 様`, source };
  }
  return { label: source ? `${source}予約` : '予約あり', source };
}
