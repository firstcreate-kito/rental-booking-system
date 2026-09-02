import { describe, it, expect } from 'vitest';
import { jstToIcsUtc, buildBookingIcs, bookingIcsAttachment, escapeIcsText, utf8ToBase64 } from '../src/lib/ics';

describe('ics - jstToIcsUtc（JST→UTC変換）', () => {
  it('13:00 JST → 04:00Z（同日・9時間引く）', () => {
    expect(jstToIcsUtc('2026-09-10', '13:00')).toBe('20260910T040000Z');
  });
  it('08:00 JST → 前日23:00Z（日跨ぎ）', () => {
    expect(jstToIcsUtc('2026-09-10', '08:00')).toBe('20260909T230000Z');
  });
  it('24:00 JST（翌日0:00）→ 15:00Z', () => {
    expect(jstToIcsUtc('2026-09-10', '24:00')).toBe('20260910T150000Z');
  });
});

describe('ics - escapeIcsText', () => {
  it('カンマ・セミコロン・改行・バックスラッシュをエスケープ', () => {
    expect(escapeIcsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });
});

describe('ics - buildBookingIcs', () => {
  const base = {
    bookingNumber: '20260910-001',
    spaceName: '東別院ピアノ室',
    days: [{ date: '2026-09-10', startTime: '13:00', endTime: '15:00' }],
    url: 'https://booking.space-albe.com/booking-change/?num=20260910-001',
  };
  it('VCALENDAR/VEVENT・UID・日時・件名を含む（PUBLISH）', () => {
    const s = buildBookingIcs(base);
    expect(s).toContain('BEGIN:VCALENDAR');
    expect(s).toContain('METHOD:PUBLISH');
    expect(s).toContain('BEGIN:VEVENT');
    expect(s).toContain('UID:20260910-001-0@booking.space-albe.com');
    expect(s).toContain('DTSTART:20260910T040000Z');
    expect(s).toContain('DTEND:20260910T060000Z');
    expect(s).toContain('SUMMARY:レンタルスペースALBE ご予約（東別院ピアノ室）');
    expect(s).toContain('STATUS:CONFIRMED');
    expect(s).toContain('END:VCALENDAR');
    // CRLF 改行
    expect(s).toContain('\r\n');
  });
  it('複数日程は VEVENT を複数生成（UIDは連番）', () => {
    const s = buildBookingIcs({
      ...base,
      days: [
        { date: '2026-09-10', startTime: '13:00', endTime: '15:00' },
        { date: '2026-09-11', startTime: '10:00', endTime: '12:00' },
      ],
    });
    expect((s.match(/BEGIN:VEVENT/g) || []).length).toBe(2);
    expect(s).toContain('UID:20260910-001-0@booking.space-albe.com');
    expect(s).toContain('UID:20260910-001-1@booking.space-albe.com');
  });
  it('cancel モードは METHOD:CANCEL・STATUS:CANCELLED', () => {
    const s = buildBookingIcs({ ...base, mode: 'cancel' });
    expect(s).toContain('METHOD:CANCEL');
    expect(s).toContain('STATUS:CANCELLED');
  });
  it('再送（now が大きい）ほど SEQUENCE が大きい', () => {
    const a = buildBookingIcs({ ...base, now: 1_700_000_000_000 });
    const b = buildBookingIcs({ ...base, now: 1_700_000_600_000 }); // 10分後
    const seqA = Number(/SEQUENCE:(\d+)/.exec(a)![1]);
    const seqB = Number(/SEQUENCE:(\d+)/.exec(b)![1]);
    expect(seqB).toBeGreaterThan(seqA);
  });
});

describe('ics - bookingIcsAttachment', () => {
  it('日程なしは null', () => {
    expect(bookingIcsAttachment({ bookingNumber: 'B1', spaceName: 'S', days: [] })).toBeNull();
  });
  it('filename・base64 content・content_type を返す', () => {
    const a = bookingIcsAttachment({
      bookingNumber: '20260910-001',
      spaceName: '東別院ピアノ室',
      days: [{ date: '2026-09-10', startTime: '13:00', endTime: '15:00' }],
    })!;
    expect(a.filename).toBe('booking-20260910-001.ics');
    expect(a.contentType).toContain('text/calendar');
    // base64 をデコードすると VCALENDAR に戻る（UTF-8）
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0)));
    expect(decoded).toContain('BEGIN:VCALENDAR');
    expect(decoded).toContain('東別院ピアノ室');
  });
});

describe('ics - utf8ToBase64', () => {
  it('日本語を正しくbase64化（往復一致）', () => {
    const s = '予約テスト🎹';
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(utf8ToBase64(s)), (c) => c.charCodeAt(0)));
    expect(decoded).toBe(s);
  });
});
