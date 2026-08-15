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

// 全メール共通の署名（フッター）#46
const SIGNATURE_TEXT = `
----------------------------------------
レンタルスペースALBE
（運営会社：株式会社ファーストクリエイト）
名古屋市中村区名駅南1-3-14 石原ビル4F
rental@space-albe.com
https://space-albe.com/`;

const SIGNATURE_HTML = `<hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0">
<div style="font-family:sans-serif;font-size:12px;color:#6b7280;line-height:1.7">
<strong>レンタルスペースALBE</strong>（運営会社：株式会社ファーストクリエイト）<br>
名古屋市中村区名駅南1-3-14 石原ビル4F<br>
<a href="mailto:rental@space-albe.com" style="color:#6b7280">rental@space-albe.com</a><br>
<a href="https://space-albe.com/" style="color:#1d4ed8">https://space-albe.com/</a>
</div>`;

/** 各テンプレートの返却に共通署名を付与する（全メール共通）#46 */
function withSignature(m: { subject: string; html: string; text: string }): { subject: string; html: string; text: string } {
  return { subject: m.subject, html: m.html + '\n' + SIGNATURE_HTML, text: m.text + '\n' + SIGNATURE_TEXT };
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
ご不明な点がございましたらお問い合わせください。`;
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
<p style="color:#6b7280;font-size:13px">ご不明な点がございましたらお問い合わせください。</p>
</div>`;
  return withSignature({ subject, html, text });
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

またのご利用をお待ちしております。`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>以下のご予約のキャンセルを承りました。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
</table>
<p>${d.cancelFee > 0 ? `キャンセル料（税込）: <strong>${yen(d.cancelFee)}</strong>` : 'キャンセル料は発生しません。'}</p>
<p style="color:#6b7280;font-size:13px">またのご利用をお待ちしております。</p>
</div>`;
  return withSignature({ subject, html, text });
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
  /** 変更前の合計金額（税込）。指定時は「変更前→変更後」と差額を表示 */
  oldTotal?: number;
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

/** 変更前後の日程が同一かどうか（日付・開始・終了すべて一致・順不同） */
function sameDays(a: RescheduleEmailData['oldDays'], b: RescheduleEmailData['newDays']): boolean {
  if (a.length !== b.length) return false;
  const key = (d: { date: string; startTime: string; endTime: string }) => `${d.date} ${d.startTime}-${d.endTime}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((v, i) => v === sb[i]);
}

/** 差額の文言（追加請求／返金／変動なし） */
function diffLabel(oldTotal: number, newTotal: number): string {
  const diff = newTotal - oldTotal;
  if (diff > 0) return `差額 +${yen(diff)}（追加のお支払いが必要です）`;
  if (diff < 0) return `差額 -${yen(-diff)}（${yen(-diff)}をご返金いたします）`;
  return '差額なし（金額の変更はありません）';
}

/** 金額の変更点ブロック（テキスト）。oldTotal指定かつ増減ありなら 変更前→変更後＋差額 */
function amountBlockText(d: RescheduleEmailData): string {
  if (!d.showAmount) return '';
  if (d.oldTotal !== undefined && d.oldTotal !== d.total) {
    return `\n\n【お支払い金額の変更】\n  変更前（税込）: ${yen(d.oldTotal)}\n  変更後（税込）: ${yen(d.total)}\n  ${diffLabel(d.oldTotal, d.total)}`;
  }
  return `\n\n変更後の合計金額（税込）: ${yen(d.total)}`;
}

/** 金額の変更点ブロック（HTML）。oldTotal指定かつ増減ありなら 変更前→変更後＋差額 */
function amountBlockHtml(d: RescheduleEmailData): string {
  if (!d.showAmount) return '';
  if (d.oldTotal !== undefined && d.oldTotal !== d.total) {
    const diff = d.total - d.oldTotal;
    const color = diff > 0 ? '#b45309' : '#15803d';
    return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;margin:12px 0;background:#f9fafb">
<p style="margin:2px 0;color:#6b7280;font-size:13px">お支払い金額の変更</p>
<p style="margin:2px 0">変更前（税込）: <span style="color:#9ca3af;text-decoration:line-through">${yen(d.oldTotal)}</span></p>
<p style="margin:2px 0;font-size:18px">変更後（税込）: <strong>${yen(d.total)}</strong></p>
<p style="margin:4px 0 0;color:${color};font-weight:600">${diffLabel(d.oldTotal, d.total)}</p>
</div>`;
  }
  return `<p style="font-size:18px">変更後の合計金額（税込）: <strong>${yen(d.total)}</strong></p>`;
}

/** 変更点の要約（日時が変わったか／金額が変わったか） */
function changeSummaryText(d: RescheduleEmailData): string {
  const parts: string[] = [];
  if (!sameDays(d.oldDays, d.newDays)) parts.push('ご利用日時');
  if (d.options !== undefined) parts.push('オプション');
  if (d.showAmount && d.oldTotal !== undefined && d.oldTotal !== d.total) parts.push('お支払い金額');
  if (parts.length === 0) return '';
  return `【変更点】${parts.join('・')}\n\n`;
}
function changeSummaryHtml(d: RescheduleEmailData): string {
  const parts: string[] = [];
  if (!sameDays(d.oldDays, d.newDays)) parts.push('ご利用日時');
  if (d.options !== undefined) parts.push('オプション');
  if (d.showAmount && d.oldTotal !== undefined && d.oldTotal !== d.total) parts.push('お支払い金額');
  if (parts.length === 0) return '';
  return `<p style="margin:8px 0"><span style="display:inline-block;background:#eff6ff;color:#1d4ed8;border-radius:6px;padding:3px 10px;font-size:13px;font-weight:600">変更点: ${parts.map(escapeHtml).join('・')}</span></p>`;
}

/** 日時変更のお知らせ（お客様宛） */
export function rescheduleEmail(d: RescheduleEmailData): { subject: string; html: string; text: string } {
  const label = d.status === 'tentative' ? '仮予約（商談中）' : 'ご予約';
  const subject = `【レンタルスペースALBE】${label}の内容を変更しました（${d.bookingNumber}）`;
  const amountText = amountBlockText(d);
  const text = `${d.customerName} 様

${label}の内容を下記の通り変更いたしました。

${changeSummaryText(d)}予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
イベント名: ${d.eventName}

【変更前の日時】
${daysBlockText(d.oldDays)}

【変更後の日時】
${daysBlockText(d.newDays)}${optionsBlockText(d.options)}${amountText}

ご不明な点がございましたらお問い合わせください。`;
  const amountHtml = amountBlockHtml(d);
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p><strong>${label}</strong>の内容を下記の通り変更いたしました。</p>
${changeSummaryHtml(d)}
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
<p style="color:#6b7280;font-size:13px">ご不明な点がございましたらお問い合わせください。</p>
</div>`;
  return withSignature({ subject, html, text });
}

/** 日時変更の管理者通知メール */
export function adminRescheduleEmail(d: RescheduleEmailData & { customerEmail?: string; customerPhone?: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const label = d.status === 'tentative' ? '商談中（仮予約）' : '本予約';
  const subject = `【予約内容変更】${d.spaceName} ${d.newDays[0]?.date ?? ''}（${d.bookingNumber}）`;
  const amountText = amountBlockText(d);
  const contact = d.customerEmail ? `\nお客様: ${d.customerName}（${d.customerEmail}${d.customerPhone ? ' / ' + d.customerPhone : ''}）` : `\nお客様: ${d.customerName}`;
  const text = `${label}の内容が変更されました。

${changeSummaryText(d)}予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
イベント名: ${d.eventName}

【変更前の日時】
${daysBlockText(d.oldDays)}

【変更後の日時】
${daysBlockText(d.newDays)}${optionsBlockText(d.options)}${amountText}${contact}`;
  const amountHtml = amountBlockHtml(d);
  const contactHtml = d.customerEmail
    ? `${escapeHtml(d.customerName)}（${escapeHtml(d.customerEmail)}${d.customerPhone ? ' / ' + escapeHtml(d.customerPhone) : ''}）`
    : escapeHtml(d.customerName);
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p><strong>${label}</strong>の内容が変更されました。</p>
${changeSummaryHtml(d)}
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
  return withSignature({ subject, html, text });
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
※お心当たりがない場合は、このメールは破棄してください。パスワードは変更されません。`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>パスワード再設定のご依頼を受け付けました。<br>下記のボタンから新しいパスワードを設定してください。</p>
<p style="margin:20px 0"><a href="${escapeHtml(d.resetUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">新しいパスワードを設定する</a></p>
<p style="font-size:12px;color:#6b7280">ボタンが開けない場合は、次のURLをブラウザに貼り付けてください：<br>${escapeHtml(d.resetUrl)}</p>
<p style="font-size:13px;color:#6b7280">※このリンクの有効期限は${escapeHtml(d.expiresLabel)}です。<br>※お心当たりがない場合は、このメールは破棄してください。パスワードは変更されません。</p>
</div>`;
  return withSignature({ subject, html, text });
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
  return withSignature({ subject, html, text });
}

export interface OverdueBooking {
  bookingNumber: string;
  spaceName: string;
  total: number;
  createdAt: string;
  paymentMethod: string | null;
  recipientName: string;
  customerEmail: string | null;
}

/** 未入金アラート（管理者宛・#41/#42）。予約確定後、期日を過ぎても入金がない予約を通知する。 */
export function unpaidAlertEmail(d: { days: number; bookings: OverdueBooking[] }): {
  subject: string;
  html: string;
  text: string;
} {
  const n = d.bookings.length;
  const subject = `【要確認】${d.days}日以上 未入金の予約が ${n} 件あります`;
  const line = (b: OverdueBooking) =>
    `${b.bookingNumber}  ${b.spaceName}  ${yen(b.total)}  宛名:${b.recipientName}  受注:${(b.createdAt || '').slice(0, 10)}  ${b.customerEmail || ''}`;
  const text = `予約確定から${d.days}日以上経過しても入金が確認できていない予約が ${n} 件あります。
入金状況をご確認のうえ、必要に応じてお客様へご連絡ください。入金確認後は管理画面から領収書を発行できます。

${d.bookings.map(line).join('\n')}

※このメールは自動送信です（1予約につき1回のみ）。`;
  const rows = d.bookings
    .map(
      (b) =>
        `<tr><td style="padding:6px 10px;border:1px solid #e5e7eb"><strong>${escapeHtml(b.bookingNumber)}</strong></td>
<td style="padding:6px 10px;border:1px solid #e5e7eb">${escapeHtml(b.spaceName)}</td>
<td style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right">${yen(b.total)}</td>
<td style="padding:6px 10px;border:1px solid #e5e7eb">${escapeHtml(b.recipientName)}</td>
<td style="padding:6px 10px;border:1px solid #e5e7eb">${escapeHtml((b.createdAt || '').slice(0, 10))}</td>
<td style="padding:6px 10px;border:1px solid #e5e7eb">${escapeHtml(b.customerEmail || '')}</td></tr>`,
    )
    .join('');
  const html = `<div style="font-family:sans-serif;line-height:1.6;color:#1f2937">
<p>予約確定から<strong>${d.days}日以上</strong>経過しても入金が確認できていない予約が <strong>${n}件</strong> あります。<br>
入金状況をご確認のうえ、必要に応じてお客様へご連絡ください。入金確認後は管理画面から領収書を発行できます。</p>
<table style="border-collapse:collapse;margin:12px 0;font-size:13px">
<tr style="background:#f3f4f6">
<th style="padding:6px 10px;border:1px solid #e5e7eb">予約番号</th>
<th style="padding:6px 10px;border:1px solid #e5e7eb">スペース</th>
<th style="padding:6px 10px;border:1px solid #e5e7eb">金額</th>
<th style="padding:6px 10px;border:1px solid #e5e7eb">宛名</th>
<th style="padding:6px 10px;border:1px solid #e5e7eb">受注日</th>
<th style="padding:6px 10px;border:1px solid #e5e7eb">連絡先</th></tr>
${rows}
</table>
<p style="color:#6b7280;font-size:12px">※このメールは自動送信です（1予約につき1回のみ通知）。</p>
</div>`;
  return withSignature({ subject, html, text });
}

// ---------------------------------------------------------------------------
// 追加の通知メール（#48/#49/#51/#52/#53）
// ---------------------------------------------------------------------------

export interface DaysList {
  days: ReadonlyArray<{ date: string; startTime: string; endTime: string }>;
}

/** 入金確認・予約確定メール（お客様宛）#49 — 銀行振込の入金確認時など */
export function paymentConfirmedEmail(d: {
  customerName: string;
  bookingNumber: string;
  spaceName: string;
  eventName: string;
  days: DaysList['days'];
  total: number;
  receiptUrl?: string;
}): { subject: string; html: string; text: string } {
  const subject = `【レンタルスペースALBE】ご入金を確認し、ご予約が確定しました（${d.bookingNumber}）`;
  const receiptText = d.receiptUrl ? `\n領収書はこちらからダウンロードいただけます。\n${d.receiptUrl}\n` : '';
  const text = `${d.customerName} 様

ご入金を確認いたしました。以下のご予約が正式に確定しました。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
イベント名: ${d.eventName}
日時:
${daysBlockText(d.days)}
合計金額（税込）: ${yen(d.total)}
${receiptText}
当日のご来店をお待ちしております。`;
  const receiptHtml = d.receiptUrl
    ? `<p style="margin:14px 0;padding:12px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px">📄 領収書をご用意しました。<br><a href="${escapeHtml(d.receiptUrl)}" style="color:#047857;font-weight:700">領収書を表示・保存する ▶</a></p>`
    : '';
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>ご入金を確認いたしました。以下のご予約が<strong>正式に確定</strong>しました。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">イベント名</td><td>${escapeHtml(d.eventName)}</td></tr>
</table>
<p style="margin:6px 0;color:#6b7280">日時</p>
<ul style="margin:4px 0">${daysBlockHtml(d.days)}</ul>
<p style="font-size:18px">合計金額（税込）: <strong>${yen(d.total)}</strong></p>
${receiptHtml}
<p style="color:#6b7280;font-size:13px">当日のご来店をお待ちしております。</p>
</div>`;
  return withSignature({ subject, html, text });
}

/** 入金確認 管理者通知メール #49 */
export function adminPaymentConfirmedEmail(d: {
  bookingNumber: string;
  spaceName: string;
  total: number;
  paymentMethodLabel: string;
  customerName: string;
  customerEmail?: string;
}): { subject: string; html: string; text: string } {
  const subject = `【入金確認】${d.spaceName}（${d.bookingNumber}）`;
  const text = `入金が確認され、予約が確定しました。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
金額: ${yen(d.total)}
お支払い方法: ${d.paymentMethodLabel}
お客様: ${d.customerName}${d.customerEmail ? '（' + d.customerEmail + '）' : ''}`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p><strong>入金が確認され、予約が確定しました。</strong></p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">金額</td><td>${yen(d.total)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">お支払い方法</td><td>${escapeHtml(d.paymentMethodLabel)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">お客様</td><td>${escapeHtml(d.customerName)}${d.customerEmail ? '（' + escapeHtml(d.customerEmail) + '）' : ''}</td></tr>
</table>
</div>`;
  return withSignature({ subject, html, text });
}

/** キャンセル 管理者通知メール #48 */
export function adminCancellationEmail(d: {
  bookingNumber: string;
  spaceName: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  cancelFee: number;
}): { subject: string; html: string; text: string } {
  const subject = `【キャンセル】${d.spaceName}（${d.bookingNumber}）`;
  const feeLine = d.cancelFee > 0 ? `キャンセル料（税込）: ${yen(d.cancelFee)}` : 'キャンセル料なし';
  const text = `予約がキャンセルされました。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
${feeLine}
お客様: ${d.customerName}${d.customerEmail ? '（' + d.customerEmail + (d.customerPhone ? ' / ' + d.customerPhone : '') + '）' : ''}`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p><strong>予約がキャンセルされました。</strong></p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">キャンセル料</td><td>${d.cancelFee > 0 ? yen(d.cancelFee) : 'なし'}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">お客様</td><td>${escapeHtml(d.customerName)}${d.customerEmail ? '（' + escapeHtml(d.customerEmail) + (d.customerPhone ? ' / ' + escapeHtml(d.customerPhone) : '') + '）' : ''}</td></tr>
</table>
</div>`;
  return withSignature({ subject, html, text });
}

/** 会員登録完了（ウェルカム）メール #51 */
export function welcomeEmail(d: { customerName: string; mypageUrl?: string; bookingUrl?: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = '【レンタルスペースALBE】会員登録が完了しました';
  const links =
    (d.mypageUrl ? `\nマイページ: ${d.mypageUrl}` : '') + (d.bookingUrl ? `\nご予約: ${d.bookingUrl}` : '');
  const text = `${d.customerName} 様

会員登録が完了しました。ありがとうございます。
マイページから、ご予約・ポイント・クーポン・回数券・書類（請求書/領収書）をご確認いただけます。
${links}

ご利用をお待ちしております。`;
  const btn = d.mypageUrl
    ? `<p style="margin:18px 0"><a href="${escapeHtml(d.mypageUrl)}" style="display:inline-block;background:#1f6feb;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none">マイページを開く</a></p>`
    : '';
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p><strong>会員登録が完了しました。</strong>ありがとうございます。<br>マイページから、ご予約・ポイント・クーポン・回数券・書類（請求書/領収書）をご確認いただけます。</p>
${btn}
<p style="color:#6b7280;font-size:13px">ご利用をお待ちしております。</p>
</div>`;
  return withSignature({ subject, html, text });
}

/** チケット（回数券）購入完了メール #52 */
export function ticketPurchaseEmail(d: {
  customerName: string;
  productName: string;
  totalHours: number;
  validUntil: string;
  amount: number;
  mypageUrl?: string;
}): { subject: string; html: string; text: string } {
  const subject = `【レンタルスペースALBE】回数券のご購入が完了しました`;
  const text = `${d.customerName} 様

回数券のご購入が完了しました。

商品名: ${d.productName}
利用可能時間: ${d.totalHours}時間
有効期限: ${d.validUntil}
ご購入金額（税込）: ${yen(d.amount)}
${d.mypageUrl ? `\nマイページ「チケット」でご確認いただけます。\n${d.mypageUrl}\n` : ''}
ご予約時に選択すると、利用時間分がスペース料金に充当されます。`;
  const btn = d.mypageUrl
    ? `<p style="margin:16px 0"><a href="${escapeHtml(d.mypageUrl)}" style="display:inline-block;background:#1f6feb;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none">マイページで確認する</a></p>`
    : '';
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p><strong>回数券のご購入が完了しました。</strong></p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">商品名</td><td><strong>${escapeHtml(d.productName)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">利用可能時間</td><td>${d.totalHours}時間</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">有効期限</td><td>${escapeHtml(d.validUntil)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">ご購入金額（税込）</td><td>${yen(d.amount)}</td></tr>
</table>
${btn}
<p style="color:#6b7280;font-size:13px">ご予約時に選択すると、利用時間分がスペース料金に充当されます。</p>
</div>`;
  return withSignature({ subject, html, text });
}

/** 利用前リマインダー（お客様宛）#45 */
export function bookingReminderEmail(d: {
  customerName: string;
  bookingNumber: string;
  spaceName: string;
  eventName: string;
  days: DaysList['days'];
  daysBefore: number;
}): { subject: string; html: string; text: string } {
  const when = d.daysBefore === 1 ? '明日' : `${d.daysBefore}日後`;
  const subject = `【レンタルスペースALBE】ご利用${when}のご予約リマインダー（${d.bookingNumber}）`;
  const text = `${d.customerName} 様

ご利用${when}のご予約をリマインドいたします。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
イベント名: ${d.eventName}
日時:
${daysBlockText(d.days)}

当日のご来店をお待ちしております。ご不明な点がございましたらお問い合わせください。`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>ご利用<strong>${when}</strong>のご予約をリマインドいたします。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">イベント名</td><td>${escapeHtml(d.eventName)}</td></tr>
</table>
<p style="margin:6px 0;color:#6b7280">日時</p>
<ul style="margin:4px 0">${daysBlockHtml(d.days)}</ul>
<p style="color:#6b7280;font-size:13px">当日のご来店をお待ちしております。ご不明な点がございましたらお問い合わせください。</p>
</div>`;
  return withSignature({ subject, html, text });
}

/** 未入金リマインダー（お客様宛）#50 — キャンセルの可能性を明記 */
export function unpaidCustomerReminderEmail(d: {
  customerName: string;
  bookingNumber: string;
  spaceName: string;
  total: number;
  days: DaysList['days'];
}): { subject: string; html: string; text: string } {
  const subject = `【レンタルスペースALBE】お振込みのご確認のお願い（${d.bookingNumber}）`;
  const text = `${d.customerName} 様

下記ご予約について、現時点でご入金の確認ができておりません。
お手数ですが、お振込み状況をご確認いただけますようお願いいたします。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
日時:
${daysBlockText(d.days)}
お支払い金額（税込）: ${yen(d.total)}

※既にお振込み済みの場合は行き違いですのでご容赦ください。
※何度かご連絡してもご入金の確認ができない場合は、誠に恐れ入りますが、ご予約をキャンセルとさせていただくことがございます。`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>下記ご予約について、現時点で<strong>ご入金の確認ができておりません</strong>。<br>お手数ですが、お振込み状況をご確認いただけますようお願いいたします。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
</table>
<p style="margin:6px 0;color:#6b7280">日時</p>
<ul style="margin:4px 0">${daysBlockHtml(d.days)}</ul>
<p style="font-size:16px">お支払い金額（税込）: <strong>${yen(d.total)}</strong></p>
<p style="color:#6b7280;font-size:13px">※既にお振込み済みの場合は行き違いですのでご容赦ください。<br>※何度かご連絡してもご入金の確認ができない場合は、誠に恐れ入りますが、ご予約をキャンセルとさせていただくことがございます。</p>
</div>`;
  return withSignature({ subject, html, text });
}

/** 利用後のお礼／再利用促進（お客様宛）#53 */
export function thankYouEmail(d: {
  customerName: string;
  spaceName: string;
  bookingUrl?: string;
}): { subject: string; html: string; text: string } {
  const subject = `【レンタルスペースALBE】ご利用ありがとうございました`;
  const text = `${d.customerName} 様

先日は「${d.spaceName}」をご利用いただき、誠にありがとうございました。
またのご利用を心よりお待ちしております。
${d.bookingUrl ? `\nご予約はこちら：\n${d.bookingUrl}\n` : ''}
ご意見・ご要望がございましたら、お気軽にお問い合わせください。`;
  const btn = d.bookingUrl
    ? `<p style="margin:16px 0"><a href="${escapeHtml(d.bookingUrl)}" style="display:inline-block;background:#1f6feb;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none">次回のご予約はこちら</a></p>`
    : '';
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>先日は「<strong>${escapeHtml(d.spaceName)}</strong>」をご利用いただき、誠にありがとうございました。<br>またのご利用を心よりお待ちしております。</p>
${btn}
<p style="color:#6b7280;font-size:13px">ご意見・ご要望がございましたら、お気軽にお問い合わせください。</p>
</div>`;
  return withSignature({ subject, html, text });
}
