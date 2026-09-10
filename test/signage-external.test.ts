import { describe, it, expect } from 'vitest';
import { parseExternalDisplayName, detectExternalSource } from '../src/lib/signage-external';

describe('detectExternalSource', () => {
  it('スペースマーケット / インスタベース を判定', () => {
    expect(detectExternalSource('【予約完了】小野 奈津佳 様(スペースマーケット予約 ID:5963333)')).toBe('スペースマーケット');
    expect(detectExternalSource('【インスタベース】予約確定 - 若山 南沙様 (予約ID: 4158942198)')).toBe('インスタベース');
    expect(detectExternalSource('instabase booking')).toBe('インスタベース');
    expect(detectExternalSource('普通の予定')).toBe(null);
  });
});

describe('parseExternalDisplayName（外部予約タイトル→姓＋様）', () => {
  it('インスタベース：氏名から姓＋様（実データ書式）', () => {
    const r = parseExternalDisplayName('【インスタベース】予約確定 - 若山 南沙様 (予約ID: 4158942198)');
    expect(r.label).toBe('若山 様');
    expect(r.source).toBe('インスタベース');
  });
  it('スペースマーケット：氏名から姓＋様（実データ書式）', () => {
    const r = parseExternalDisplayName('【予約完了】小野 奈津佳 様(スペースマーケット予約 ID:5963333)');
    expect(r.label).toBe('小野 様');
    expect(r.source).toBe('スペースマーケット');
  });
  it('全角スペース区切りの氏名でも姓だけ', () => {
    expect(parseExternalDisplayName('【予約完了】田中　太郎 様(スペースマーケット予約 ID:1)').label).toBe('田中 様');
  });
  it('氏名が取れない場合は出どころ名＋予約', () => {
    expect(parseExternalDisplayName('【スペースマーケット予約 ID:1】').label).toBe('スペースマーケット予約');
  });
  it('氏名も出どころも不明なら「予約あり」', () => {
    expect(parseExternalDisplayName('会議').label).toBe('予約あり');
    expect(parseExternalDisplayName('').label).toBe('予約あり');
  });
  it('個人情報（フルネーム・予約ID・利用目的）は表示名に出さない', () => {
    const r = parseExternalDisplayName('【インスタベース】予約確定 - 若山 南沙様 (予約ID: 4158942198)');
    expect(r.label).not.toContain('南沙');
    expect(r.label).not.toContain('4158942198');
  });
});
