import { describe, it, expect } from 'vitest';
import { signageLastName, signageDisplayName, signageTimeRange, buildSignageItems } from '../src/lib/signage-display';

describe('signageLastName（苗字だけ）', () => {
  it('「姓 名」から姓だけを返す', () => {
    expect(signageLastName('山田 太郎')).toBe('山田');
    expect(signageLastName('鬼頭 一郎')).toBe('鬼頭');
  });
  it('全角スペース区切りにも対応', () => {
    expect(signageLastName('佐藤　花子')).toBe('佐藤');
  });
  it('スペースが無ければ全体を返す（会社名など）', () => {
    expect(signageLastName('株式会社アルベ')).toBe('株式会社アルベ');
  });
  it('空/nullは空文字', () => {
    expect(signageLastName('')).toBe('');
    expect(signageLastName(null)).toBe('');
    expect(signageLastName(undefined)).toBe('');
  });
});

describe('signageDisplayName（イベント名優先→無ければ姓＋様）', () => {
  it('イベント名があれば優先', () => {
    expect(signageDisplayName('撮影会', '山田 太郎')).toBe('撮影会');
    expect(signageDisplayName('  ピアノ発表会  ', '山田 太郎')).toBe('ピアノ発表会');
  });
  it('イベント名が無ければ姓＋様', () => {
    expect(signageDisplayName('', '山田 太郎')).toBe('山田 様');
    expect(signageDisplayName(null, '佐藤　花子')).toBe('佐藤 様');
  });
  it('イベント名も名前も無ければフォールバック', () => {
    expect(signageDisplayName('', '')).toBe('予約あり');
    expect(signageDisplayName(null, null)).toBe('予約あり');
  });
});

describe('signageTimeRange', () => {
  it('「10:00～11:00」形式', () => {
    expect(signageTimeRange('10:00', '11:00')).toBe('10:00～11:00');
    expect(signageTimeRange('09:30', '24:00')).toBe('09:30～24:00');
  });
});

describe('buildSignageItems（終了済み除外・ongoing/upcoming判定）', () => {
  const rows = [
    { start_time: '09:00', end_time: '10:00', event_name: '朝練', contact_name: '田中 一郎' },
    { start_time: '10:00', end_time: '12:00', event_name: '', contact_name: '山田 太郎' },
    { start_time: '13:00', end_time: '15:00', event_name: 'ワークショップ', contact_name: null },
  ];
  it('現在10:30：終了済み(09:00-10:00)は除外、10:00-12:00はongoing、13:00-はupcoming', () => {
    const items = buildSignageItems(rows, '10:30');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ label: '山田 様', range: '10:00～12:00', status: 'ongoing' });
    expect(items[1]).toMatchObject({ label: 'ワークショップ', range: '13:00～15:00', status: 'upcoming' });
  });
  it('開始ちょうどはongoing（start<=now<end）', () => {
    const items = buildSignageItems(rows, '13:00');
    const ws = items.find((i) => i.label === 'ワークショップ');
    expect(ws?.status).toBe('ongoing');
  });
  it('全て終了後は空配列', () => {
    expect(buildSignageItems(rows, '23:00')).toHaveLength(0);
  });
  it('開始時刻順に並ぶ', () => {
    const shuffled = [rows[2], rows[0], rows[1]];
    const items = buildSignageItems(shuffled, '08:00');
    expect(items.map((i) => i.start)).toEqual(['09:00', '10:00', '13:00']);
  });
});
