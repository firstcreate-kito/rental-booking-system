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
  /** マイページURL（会員の場合。請求書・領収書のダウンロード導線に使う） */
  mypageUrl?: string;
  /** 請求書払いの場合 true（請求書の案内文を出す） */
  isInvoice?: boolean;
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
${
  d.mypageUrl
    ? `\n${d.isInvoice ? '請求書' : '領収書'}はマイページの「書類」からダウンロードいただけます。\n${d.mypageUrl}\n`
    : ''
}
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
${
  d.mypageUrl
    ? `<p style="margin:14px 0;padding:12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px">
📄 ${d.isInvoice ? '請求書' : '領収書'}はマイページの「書類」からダウンロードいただけます。<br>
<a href="${escapeHtml(d.mypageUrl)}" style="color:#1d4ed8;font-weight:700">マイページで書類を確認する ▶</a></p>`
    : ''
}
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

export interface RescheduleEmailData {
  bookingNumber: string;
  spaceName: string;
  eventName: string;
  customerName: string;
  oldDays: ReadonlyArray<{ date: string; startTime: string; endTime: string }>;
  newDays: ReadonlyArray<{ date: string; startTime: string; endTime: string }>;
  total: number;
  status: 'confirmed' | 'tentative';
  /** 商談中など金額未確定のケースは false（金額行を出さない） */
  showAmount: boolean;
  /** 変更後のオプション（undefined=セクションを出さない / []=「なし」） */
  options?: ReadonlyArray<{ name: string; quantity: number; subtotal: number }>;
}

function optionsBlockText(options?: RescheduleEmailData['options']): string {
  if (options === undefined) return '';
  if (options.length === 0) return '\n\n【オプション】\n  なし';
  return '\n\n【オプション】\n' + options.map((o) => `  ${o.name} × ${o.quantity}　${yen(o.subtotal)}`).join('\n');
}
function optionsBlockHtml(options?: RescheduleEmailData['options']): string {
  if (options === undefined) return '';
  const inner = options.length === 0 ? '<li>なし</li>' : options.map((o) => `<li>${escapeHtml(o.name)} × ${o.quantity}　${yen(o.subtotal)}</li>`).join('');
  return `<p style="margin:6px 0;color:#6b7280">オプション</p><ul style="margin:4px 0">${inner}</ul>`;
}

/** 日時変更のお知らせ（お客様宛） */
export function rescheduleEmail(d: RescheduleEmailData): { subject: string; html: string; text: string } {
  const label = d.status === 'tentative' ? '仮予約（商談中）' : 'ご予約';
  const subject = `【レンタルスペースALBE】${label}の内容を変更しました（${d.bookingNumber}）`;
  const amountText = d.showAmount ? `\n\n変更後の合計金額（税込）: ${yen(d.total)}` : '';
  const text = `${d.customerName} 様

${label}の内容を下記の通り変更いたしました。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
イベント名: ${d.eventName}

【変更前の日時】
${daysBlockText(d.oldDays)}

【変更後の日時】
${daysBlockText(d.newDays)}${optionsBlockText(d.options)}${amountText}

ご不明な点がございましたらお問い合わせください。
レンタルスペースALBE`;
  const amountHtml = d.showAmount
    ? `<p style="font-size:18px">変更後の合計金額（税込）: <strong>${yen(d.total)}</strong></p>`
    : '';
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p><strong>${label}</strong>の内容を下記の通り変更いたしました。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">イベント名</td><td>${escapeHtml(d.eventName)}</td></tr>
</table>
<p style="margin:6px 0;color:#6b7280">変更前の日時</p>
<ul style="margin:4px 0;color:#9ca3af;text-decoration:line-through">${daysBlockHtml(d.oldDays)}</ul>
<p style="margin:6px 0;color:#6b7280">変更後の日時</p>
<ul style="margin:4px 0">${daysBlockHtml(d.newDays)}</ul>
${optionsBlockHtml(d.options)}
${amountHtml}
<p style="color:#6b7280;font-size:13px">ご不明な点がございましたらお問い合わせください。<br>レンタルスペースALBE</p>
</div>`;
  return { subject, html, text };
}

/** 日時変更の管理者通知メール */
export function adminRescheduleEmail(d: RescheduleEmailData & { customerEmail?: string; customerPhone?: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const label = d.status === 'tentative' ? '商談中（仮予約）' : '本予約';
  const subject = `【予約内容変更】${d.spaceName} ${d.newDays[0]?.date ?? ''}（${d.bookingNumber}）`;
  const amountText = d.showAmount ? `\n\n変更後合計: ${yen(d.total)}` : '';
  const contact = d.customerEmail ? `\nお客様: ${d.customerName}（${d.customerEmail}${d.customerPhone ? ' / ' + d.customerPhone : ''}）` : `\nお客様: ${d.customerName}`;
  const text = `${label}の内容が変更されました。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
イベント名: ${d.eventName}

【変更前の日時】
${daysBlockText(d.oldDays)}

【変更後の日時】
${daysBlockText(d.newDays)}${optionsBlockText(d.options)}${amountText}${contact}`;
  const amountHtml = d.showAmount ? `<p>変更後合計: <strong>${yen(d.total)}</strong></p>` : '';
  const contactHtml = d.customerEmail
    ? `${escapeHtml(d.customerName)}（${escapeHtml(d.customerEmail)}${d.customerPhone ? ' / ' + escapeHtml(d.customerPhone) : ''}）`
    : escapeHtml(d.customerName);
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p><strong>${label}</strong>の内容が変更されました。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">イベント名</td><td>${escapeHtml(d.eventName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">お客様</td><td>${contactHtml}</td></tr>
</table>
<p style="margin:6px 0;color:#6b7280">変更前の日時</p>
<ul style="margin:4px 0;color:#9ca3af;text-decoration:line-through">${daysBlockHtml(d.oldDays)}</ul>
<p style="margin:6px 0;color:#6b7280">変更後の日時</p>
<ul style="margin:4px 0">${daysBlockHtml(d.newDays)}</ul>
${optionsBlockHtml(d.options)}
${amountHtml}
</div>`;
  return { subject, html, text };
}

/** パスワード再設定メール（お客様宛） */
export function passwordResetEmail(d: {
  customerName: string;
  resetUrl: string;
  expiresLabel: string; // 例: 1時間
}): { subject: string; html: string; text: string } {
  const subject = '【レンタルスペースALBE】パスワード再設定のご案内';
  const text = `${d.customerName} 様

パスワード再設定のご依頼を受け付けました。
下記のURLを開き、新しいパスワードを設定してください。

${d.resetUrl}

※このリンクの有効期限は${d.expiresLabel}です。期限を過ぎた場合はお手数ですが再度お手続きください。
※お心当たりがない場合は、このメールは破棄してください。パスワードは変更されません。

レンタルスペースALBE`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>パスワード再設定のご依頼を受け付けました。<br>下記のボタンから新しいパスワードを設定してください。</p>
<p style="margin:20px 0"><a href="${escapeHtml(d.resetUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">新しいパスワードを設定する</a></p>
<p style="font-size:12px;color:#6b7280">ボタンが開けない場合は、次のURLをブラウザに貼り付けてください：<br>${escapeHtml(d.resetUrl)}</p>
<p style="font-size:13px;color:#6b7280">※このリンクの有効期限は${escapeHtml(d.expiresLabel)}です。<br>※お心当たりがない場合は、このメールは破棄してください。パスワードは変更されません。</p>
<p style="color:#6b7280;font-size:13px">レンタルスペースALBE</p>
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
