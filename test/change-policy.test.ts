import { describe, it, expect } from 'vitest';
import {
  leadDays,
  minRemainRatioForDecrease,
  rescheduleWindow,
  evaluateCancel,
  evaluateDecrease,
  evaluateReschedule,
  evaluateChange,
  SELF_CANCEL_MIN_DAYS_BEFORE,
} from '../src/lib/change-policy';

describe('leadDays（当初利用日までの残日数・暦日）', () => {
  it('同日=0（当日）', () => expect(leadDays('2026-09-20', '2026-09-20')).toBe(0));
  it('前日=1', () => expect(leadDays('2026-09-20', '2026-09-19')).toBe(1));
  it('31日前=31', () => expect(leadDays('2026-09-20', '2026-08-20')).toBe(31));
  it('経過後は負', () => expect(leadDays('2026-09-20', '2026-09-21')).toBe(-1));
});

describe('minRemainRatioForDecrease（減額の最低残存割合）', () => {
  it('31日以前 → 0（制限なし）', () => expect(minRemainRatioForDecrease(31)).toBe(0));
  it('30日前 → 0.5', () => expect(minRemainRatioForDecrease(30)).toBe(0.5));
  it('15日前 → 0.5', () => expect(minRemainRatioForDecrease(15)).toBe(0.5));
  it('14日前 → 0.8', () => expect(minRemainRatioForDecrease(14)).toBe(0.8));
  it('前日 → 0.8', () => expect(minRemainRatioForDecrease(1)).toBe(0.8));
  it('当日 → 1（減額不可）', () => expect(minRemainRatioForDecrease(0)).toBe(1));
});

describe('evaluateCancel（セルフキャンセルの3日前ライン）', () => {
  it('4日以上前 → セルフ可', () => {
    expect(evaluateCancel(4)).toMatchObject({ allowed: true, mode: 'self' });
    expect(evaluateCancel(31)).toMatchObject({ allowed: true, mode: 'self' });
  });
  it('3日前 → フォーム誘導', () => {
    const r = evaluateCancel(3);
    expect(r.allowed).toBe(false);
    expect(r.mode).toBe('form');
  });
  it('前日 → フォーム誘導', () => expect(evaluateCancel(1).allowed).toBe(false));
  it('当日 → フォーム誘導（専用文言）', () => {
    const r = evaluateCancel(0);
    expect(r.allowed).toBe(false);
    expect(r.message).toContain('当日');
  });
  it('境界定数と整合', () => expect(SELF_CANCEL_MIN_DAYS_BEFORE).toBe(4));
});

describe('evaluateDecrease（減額の範囲判定・当初金額基準）', () => {
  it('増額は常に範囲内', () => expect(evaluateDecrease(1, 10000, 12000).allowed).toBe(true));
  it('据え置きは範囲内', () => expect(evaluateDecrease(1, 10000, 10000).allowed).toBe(true));
  it('31日以前はいくら減らしてもセルフ可', () => {
    expect(evaluateDecrease(31, 10000, 1000).allowed).toBe(true);
    expect(evaluateDecrease(60, 10000, 0).allowed).toBe(true);
  });
  it('30〜15日前は50%以上残ればセルフ可', () => {
    expect(evaluateDecrease(20, 10000, 5000).allowed).toBe(true); // ちょうど50%
    expect(evaluateDecrease(20, 10000, 4999).allowed).toBe(false); // 50%未満
  });
  it('14日前〜前日は80%以上残ればセルフ可', () => {
    expect(evaluateDecrease(10, 10000, 8000).allowed).toBe(true); // ちょうど80%
    expect(evaluateDecrease(10, 10000, 7999).allowed).toBe(false); // 80%未満
  });
  it('当日は減額不可（キャンセル扱い）', () => {
    const r = evaluateDecrease(0, 10000, 9000);
    expect(r.allowed).toBe(false);
    expect(r.message).toContain('当日');
  });
  it('累計判定：当初金額に対して見る（2回目の減額も当初基準）', () => {
    // 当初10000 → 1回目8000（範囲内）→ さらに減らして5000 は 20日前なら50%でOK
    expect(evaluateDecrease(20, 10000, 5000).allowed).toBe(true);
    // 10日前（80%基準）では 5000 は不可
    expect(evaluateDecrease(10, 10000, 5000).allowed).toBe(false);
  });
});

describe('rescheduleWindow（当初日±1ヶ月）', () => {
  it('通常の月', () => {
    expect(rescheduleWindow('2026-09-20', 1)).toEqual({ from: '2026-08-20', to: '2026-10-20' });
  });
  it('月末の繰り上がりは末日に丸める', () => {
    // 1/31 の +1ヶ月は 2/28（うるう年でない2026）
    const w = rescheduleWindow('2026-01-31', 1);
    expect(w.to).toBe('2026-02-28');
  });
});

describe('evaluateReschedule（日程変更）', () => {
  it('31日以前・±1ヶ月以内 → セルフ可', () => {
    expect(evaluateReschedule(31, '2026-09-20', '2026-10-10').allowed).toBe(true);
    expect(evaluateReschedule(40, '2026-09-20', '2026-08-25').allowed).toBe(true);
  });
  it('31日以前でも±1ヶ月外 → フォーム誘導', () => {
    const r = evaluateReschedule(40, '2026-09-20', '2026-11-01');
    expect(r.allowed).toBe(false);
    expect(r.mode).toBe('form');
  });
  it('30日前以降 → キャンセル＋新規（フォーム誘導）', () => {
    const r = evaluateReschedule(30, '2026-09-20', '2026-09-25');
    expect(r.allowed).toBe(false);
    expect(r.message).toContain('30日前');
  });
});

describe('evaluateChange（統合ディスパッチ）', () => {
  it('increase は常に許可', () => {
    expect(evaluateChange({ operation: 'increase', daysBefore: 0 }).allowed).toBe(true);
  });
  it('cancel は3日前ライン', () => {
    expect(evaluateChange({ operation: 'cancel', daysBefore: 5 }).allowed).toBe(true);
    expect(evaluateChange({ operation: 'cancel', daysBefore: 2 }).allowed).toBe(false);
  });
  it('decrease は当初金額基準', () => {
    expect(evaluateChange({ operation: 'decrease', daysBefore: 20, originalTotal: 10000, newTotal: 6000 }).allowed).toBe(true);
    expect(evaluateChange({ operation: 'decrease', daysBefore: 20, originalTotal: 10000, newTotal: 4000 }).allowed).toBe(false);
  });
  it('reschedule は±1ヶ月と30日ライン', () => {
    expect(evaluateChange({ operation: 'reschedule', daysBefore: 40, originalDate: '2026-09-20', newDate: '2026-10-05' }).allowed).toBe(true);
    expect(evaluateChange({ operation: 'reschedule', daysBefore: 10, originalDate: '2026-09-20', newDate: '2026-09-22' }).allowed).toBe(false);
  });
});
