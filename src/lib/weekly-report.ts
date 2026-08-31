/**
 * 週次「翌週の予約」まとめメール（#111）。
 * スペース単位で、その週（月〜日）の予約一覧を、スペースオーナー（スペース別宛先）へ通知する。
 *
 * 宛先の解決順：weekly_report_recipients（カンマ区切り複数可）→ 空なら notify_email（#72）。
 * どちらも空なら本部への一括送信はせず、そのスペースはスキップする（オーナー宛の設計）。
 * 自動送信は毎週月曜 09:00 JST（cron '0 0 * * 1'）。プレビュー/手動送信は管理画面から。
 */
import type { Env } from '../types';
import { getAllSpaces, getBookingsInDateRange, type SpaceRow } from '../db/repository';
import { weeklyReportEmail, type WeeklyReportItem } from './email';
import { sendEmail } from './email';
import { todayJST, mondayOfWeekJST, addDaysJST, weekdayLabelJST } from './clock';

/** スペース1件分の週次まとめ（プレビュー・送信で共通利用） */
export interface WeeklyReportForSpace {
  spaceId: string;
  spaceName: string;
  recipients: string[];
  weekStart: string;
  weekEnd: string;
  count: number;
  mail: { subject: string; html: string; text: string };
}

/** スペースの週次まとめ宛先を解決（複数可・重複除去）。空配列なら送信対象外 */
export function resolveWeeklyRecipients(space: Pick<SpaceRow, 'weekly_report_recipients' | 'notify_email'>): string[] {
  const raw = (space.weekly_report_recipients ?? '').trim() || (space.notify_email ?? '').trim();
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

/**
 * 「翌週」（today を含む週の“次の”月〜日）の予約を、有効な全スペース分だけ組み立てる。
 * 毎週月曜の朝に送るので、月曜時点で1週間先の予定を前倒しで案内する。
 * 送信はしない（プレビューにも使う）。予約0件のスペースも count:0 で返す。
 */
export async function buildWeeklyReports(env: Env, today: string = todayJST()): Promise<WeeklyReportForSpace[]> {
  const weekStart = addDaysJST(mondayOfWeekJST(today), 7); // 翌週の月曜
  const weekEnd = addDaysJST(weekStart, 6); // 翌週の日曜
  const [spaces, rows] = await Promise.all([
    getAllSpaces(env.DB),
    getBookingsInDateRange(env.DB, weekStart, weekEnd),
  ]);
  const adminUrl = env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL}/admin.html` : undefined;

  const bySpace = new Map<string, WeeklyReportItem[]>();
  for (const r of rows) {
    const item: WeeklyReportItem = {
      date: r.date,
      weekday: weekdayLabelJST(r.date),
      startTime: r.start_time,
      endTime: r.end_time,
      statusLabel: r.group_status === 'tentative' ? '商談中' : '確定',
      bookingNumber: r.booking_number,
      title: (r.event_name && r.event_name.trim()) || (r.contact_name && r.contact_name.trim()) || '',
      phone: r.phone,
      headcount: r.headcount,
    };
    const list = bySpace.get(r.space_id) ?? [];
    list.push(item);
    bySpace.set(r.space_id, list);
  }

  return spaces
    .filter((s) => s.is_active === 1)
    .map((s) => {
      const items = bySpace.get(s.id) ?? [];
      return {
        spaceId: s.id,
        spaceName: s.name,
        recipients: resolveWeeklyRecipients(s),
        weekStart,
        weekEnd,
        count: items.length,
        mail: weeklyReportEmail({ spaceName: s.name, weekStart, weekEnd, items, adminUrl }),
      };
    });
}

/**
 * 週次まとめメールを実送信する（cron・手動の両方から利用）。
 * 宛先ありかつ予約1件以上のスペースにのみ送る（0件のスペースは送らない＝ノイズ抑制）。
 * ステージングは sendEmail 側で実送信が停止される。
 */
export async function runWeeklyReport(env: Env, today: string = todayJST()): Promise<{ sent: number; skipped: number }> {
  const reports = await buildWeeklyReports(env, today);
  let sent = 0;
  let skipped = 0;
  for (const rep of reports) {
    if (rep.recipients.length === 0 || rep.count === 0) {
      skipped++;
      continue;
    }
    await sendEmail(env, { to: rep.recipients, ...rep.mail, internal: true });
    sent++;
  }
  console.log(`[weekly-report] spaces=${reports.length} sent=${sent} skipped=${skipped}`);
  return { sent, skipped };
}
