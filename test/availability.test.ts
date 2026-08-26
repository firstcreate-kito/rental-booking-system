import { describe, it, expect } from 'vitest';
import {
  computeDayAvailability,
  validateBookingItem,
  intervalsOverlap,
  slotCount,
  type DayAvailabilityInput,
  type BookingValidationSpace,
  type ValidationContext,
} from '../src/lib/availability';

const baseDay: Omit<DayAvailabilityInput, 'bookings'> = {
  billingType: 'hourly',
  openTime: '08:00',
  closeTime: '22:00',
  slotMinutes: 30,
  isClosed: false,
  dayAvailable: true,
  thresholdPct: 50,
};

describe('slotCount', () => {
  it('08:00-22:00 / 30分 = 28スロット', () => {
    expect(slotCount('08:00', '22:00', 30)).toBe(28);
  });
});

describe('computeDayAvailability - 時間貸し', () => {
  it('予約なし → ○(available)', () => {
    const r = computeDayAvailability({ ...baseDay, bookings: [] });
    expect(r.status).toBe('available');
    expect(r.totalSlots).toBe(28);
    expect(r.freeSlots).toBe(28);
  });

  it('空きちょうど50% → ○(available)', () => {
    // 08:00-15:00 = 14スロット占有 → 空き14 = 50%
    const r = computeDayAvailability({
      ...baseDay,
      bookings: [{ startTime: '08:00', endTime: '15:00', status: 'confirmed' }],
    });
    expect(r.freeSlots).toBe(14);
    expect(r.status).toBe('available');
  });

  it('空き50%未満 → △(limited)', () => {
    // 08:00-15:30 = 15スロット占有 → 空き13 (<50%)
    const r = computeDayAvailability({
      ...baseDay,
      bookings: [{ startTime: '08:00', endTime: '15:30', status: 'confirmed' }],
    });
    expect(r.freeSlots).toBe(13);
    expect(r.status).toBe('limited');
  });

  it('満枠 → ✕(full)', () => {
    const r = computeDayAvailability({
      ...baseDay,
      bookings: [{ startTime: '08:00', endTime: '22:00', status: 'confirmed' }],
    });
    expect(r.status).toBe('full');
    expect(r.freeSlots).toBe(0);
  });

  it('キャンセル済みは占有しない', () => {
    const r = computeDayAvailability({
      ...baseDay,
      bookings: [{ startTime: '08:00', endTime: '22:00', status: 'cancelled' }],
    });
    expect(r.status).toBe('available');
  });

  it('商談中(tentative)は占有し、hasTentative=true', () => {
    const r = computeDayAvailability({
      ...baseDay,
      bookings: [{ startTime: '10:00', endTime: '12:00', status: 'tentative' }],
    });
    expect(r.hasTentative).toBe(true);
    expect(r.freeSlots).toBe(28 - 4);
  });

  it('休業日 → closed', () => {
    const r = computeDayAvailability({ ...baseDay, isClosed: true, bookings: [] });
    expect(r.status).toBe('closed');
  });

  it('曜日区分で提供なし → closed', () => {
    const r = computeDayAvailability({ ...baseDay, dayAvailable: false, bookings: [] });
    expect(r.status).toBe('closed');
  });
});

describe('computeDayAvailability - ブロック単位', () => {
  it('予約なし→○ / 予約あり→✕', () => {
    const open = computeDayAvailability({ ...baseDay, billingType: 'block', bookings: [] });
    expect(open.status).toBe('available');
    const full = computeDayAvailability({
      ...baseDay,
      billingType: 'block',
      bookings: [{ startTime: '08:00', endTime: '22:00', status: 'confirmed' }],
    });
    expect(full.status).toBe('full');
  });
});

describe('intervalsOverlap', () => {
  it('重なりを正しく判定', () => {
    expect(intervalsOverlap('10:00', '12:00', '11:00', '13:00')).toBe(true);
    expect(intervalsOverlap('10:00', '12:00', '12:00', '13:00')).toBe(false); // 隣接は非重複
    expect(intervalsOverlap('10:00', '12:00', '09:00', '10:00')).toBe(false);
  });
});

describe('validateBookingItem', () => {
  const space: BookingValidationSpace = {
    openTime: '08:00',
    closeTime: '22:00',
    slotMinutes: 30,
    bookingHorizonDays: 60,
    bookingDeadlineDays: 1,
    weekdayAvailable: true,
    weekendAvailable: true,
  };
  const ctx: ValidationContext = {
    today: '2026-04-01',
    dayType: 'weekday',
    isClosed: false,
    defaultDeadlineDays: 0,
  };

  it('妥当な予約 → エラーなし', () => {
    const errs = validateBookingItem(space, { date: '2026-04-20', startTime: '10:00', endTime: '16:00' }, ctx);
    expect(errs).toEqual([]);
  });

  it('予約受付最終日（閉鎖日）以前は予約可・翌日以降は BEYOND_CLOSING', () => {
    const closing = { ...space, closingDate: '2026-04-25' };
    // 閉鎖日ちょうどはOK
    expect(
      validateBookingItem(closing, { date: '2026-04-25', startTime: '10:00', endTime: '12:00' }, ctx).map((e) => e.code),
    ).not.toContain('BEYOND_CLOSING');
    // 閉鎖日の翌日は不可
    expect(
      validateBookingItem(closing, { date: '2026-04-26', startTime: '10:00', endTime: '12:00' }, ctx).map((e) => e.code),
    ).toContain('BEYOND_CLOSING');
    // closingDate 未設定なら影響なし
    expect(
      validateBookingItem(space, { date: '2026-04-26', startTime: '10:00', endTime: '12:00' }, ctx).map((e) => e.code),
    ).not.toContain('BEYOND_CLOSING');
  });

  it('30分単位でない → NOT_ALIGNED', () => {
    const errs = validateBookingItem(space, { date: '2026-04-20', startTime: '10:15', endTime: '16:00' }, ctx);
    expect(errs.map((e) => e.code)).toContain('NOT_ALIGNED');
  });

  it('営業時間外 → OUT_OF_HOURS', () => {
    const errs = validateBookingItem(space, { date: '2026-04-20', startTime: '07:00', endTime: '09:00' }, ctx);
    expect(errs.map((e) => e.code)).toContain('OUT_OF_HOURS');
  });

  it('開始>=終了 → INVALID_RANGE', () => {
    const errs = validateBookingItem(space, { date: '2026-04-20', startTime: '16:00', endTime: '16:00' }, ctx);
    expect(errs.map((e) => e.code)).toContain('INVALID_RANGE');
  });

  it('予約可能期間を超過 → BEYOND_HORIZON', () => {
    const errs = validateBookingItem(
      { ...space, bookingHorizonDays: 10 },
      { date: '2026-04-20', startTime: '10:00', endTime: '16:00' },
      ctx,
    );
    expect(errs.map((e) => e.code)).toContain('BEYOND_HORIZON');
  });

  it('締切超過 → PAST_DEADLINE', () => {
    const errs = validateBookingItem(
      { ...space, bookingDeadlineDays: 5 },
      { date: '2026-04-03', startTime: '10:00', endTime: '16:00' }, // diff 2 < 5
      ctx,
    );
    expect(errs.map((e) => e.code)).toContain('PAST_DEADLINE');
  });

  it('休業日 → CLOSED', () => {
    const errs = validateBookingItem(
      space,
      { date: '2026-04-20', startTime: '10:00', endTime: '16:00' },
      { ...ctx, isClosed: true },
    );
    expect(errs.map((e) => e.code)).toContain('CLOSED');
  });

  it('土日祝で提供なし → DAY_UNAVAILABLE', () => {
    const errs = validateBookingItem(
      { ...space, weekendAvailable: false },
      { date: '2026-04-25', startTime: '10:00', endTime: '16:00' },
      { ...ctx, dayType: 'weekend' },
    );
    expect(errs.map((e) => e.code)).toContain('DAY_UNAVAILABLE');
  });
});
