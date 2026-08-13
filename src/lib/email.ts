/**
 * メール送信（Resend）と各種通知メールのテンプレート。
 *
 * - RESEND_API_KEY と MAIL_FROM の両方が設定されているときのみ実際に送信する。
 *   未設定なら no-op（ローカル開発や送信前段階でも予約処理は正常に完了する）。
 * - 送信失敗は握りつぶす（メールの失敗で予約処理を止めない）。呼び出し側は
 *   executionCtx.waitUntil() でバックグラウンド送信するとよい。
 */

export interface EmailEnv {
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  MAIL_ADMIN?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

/** Resend API で1通送信する。失敗しても例外は投げない。 */
export async function sendEmail(env: EmailEnv, msg: EmailMessage): Promise<SendResult> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    return { ok: false, skipped: true };
  }
  if (!msg.to) return { ok: false, error: 'no recipient' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `resend ${res.status}: ${detail.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// --- テンプレート ---

const yen = (n: number): string => '¥' + Number(n).toLocaleString('ja-JP');

/** HTML特殊文字のエスケープ（本文に差し込む可変値用） */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface BookingEmailData {
  bookingNumber: string;
  spaceName: string;
  eventName: string;
  customerName: string;
  days: ReadonlyArray<{ date: string; startTime: string; endTime: string }>;
  total: number;
  status: 'confirmed' | 'tentative';
}

function daysBlockText(days: BookingEmailData['days']): string {
  return days.map((d) => `  ${d.date}  ${d.startTime}〜${d.endTime}`).join('\n');
}
function daysBlockHtml(days: BookingEmailData['days']): string {
  return days
    .map((d) => `<li>${escapeHtml(d.date)}　${escapeHtml(d.startTime)}〜${escapeHtml(d.endTime)}</li>`)
    .join('');
}

/** 予約確認メール（お客様宛） */
export function bookingConfirmationEmail(d: BookingEmailData): { subject: string; html: string; text: string } {
  const label = d.status === 'tentative' ? '仮予約（商談中）' : 'ご予約';
  const subject = `【レンタルスペースALBE】${label}を承りました（${d.bookingNumber}）`;
  const text = `${d.customerName} 様

このたびはレンタルスペースALBEをご利用いただき、ありがとうございます。
以下の内容で${label}を承りました。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
イベント名: ${d.eventName}
日時:
${daysBlockText(d.days)}
合計金額（税込）: ${yen(d.total)}

ご不明な点がございましたらお問い合わせください。
レンタルスペースALBE`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>このたびはレンタルスペースALBEをご利用いただき、ありがとうございます。<br>以下の内容で<strong>${label}</strong>を承りました。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">イベント名</td><td>${escapeHtml(d.eventName)}</td></tr>
</table>
<p style="margin:6px 0;color:#6b7280">日時</p>
<ul style="margin:4px 0">${daysBlockHtml(d.days)}</ul>
<p style="font-size:18px">合計金額（税込）: <strong>${yen(d.total)}</strong></p>
<p style="color:#6b7280;font-size:13px">ご不明な点がございましたらお問い合わせください。<br>レンタルスペースALBE</p>
</div>`;
  return { subject, html, text };
}

/** キャンセル確認メール（お客様宛） */
export function cancellationEmail(d: {
  bookingNumber: string;
  spaceName: string;
  customerName: string;
  cancelFee: number;
}): { subject: string; html: string; text: string } {
  const subject = `【レンタルスペースALBE】ご予約のキャンセルを承りました（${d.bookingNumber}）`;
  const feeLine = d.cancelFee > 0 ? `キャンセル料（税込）: ${yen(d.cancelFee)}` : 'キャンセル料は発生しません。';
  const text = `${d.customerName} 様

以下のご予約のキャンセルを承りました。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
${feeLine}

またのご利用をお待ちしております。
レンタルスペースALBE`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>以下のご予約のキャンセルを承りました。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
</table>
<p>${d.cancelFee > 0 ? `キャンセル料（税込）: <strong>${yen(d.cancelFee)}</strong>` : 'キャンセル料は発生しません。'}</p>
<p style="color:#6b7280;font-size:13px">またのご利用をお待ちしております。<br>レンタルスペースALBE</p>
</div>`;
  return { subject, html, text };
}

/** 新規予約の管理者通知メール */
export function adminNewBookingEmail(d: BookingEmailData & { customerEmail: string; customerPhone?: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const label = d.status === 'tentative' ? '商談中（仮予約）' : '本予約';
  const subject = `【新規${label}】${d.spaceName} ${d.days[0]?.date ?? ''}（${d.bookingNumber}）`;
  const text = `新しい${label}が入りました。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
イベント名: ${d.eventName}
日時:
${daysBlockText(d.days)}
合計: ${yen(d.total)}
お客様: ${d.customerName}（${d.customerEmail}${d.customerPhone ? ' / ' + d.customerPhone : ''}）`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>新しい<strong>${label}</strong>が入りました。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">イベント名</td><td>${escapeHtml(d.eventName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">お客様</td><td>${escapeHtml(d.customerName)}（${escapeHtml(d.customerEmail)}${d.customerPhone ? ' / ' + escapeHtml(d.customerPhone) : ''}）</td></tr>
</table>
<p style="margin:6px 0;color:#6b7280">日時</p>
<ul style="margin:4px 0">${daysBlockHtml(d.days)}</ul>
<p>合計: <strong>${yen(d.total)}</strong></p>
</div>`;
  return { subject, html, text };
}
