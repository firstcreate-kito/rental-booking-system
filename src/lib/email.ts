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
  /** 宛先。複数指定可（スペース別通知先＋本部など）#72 */
  to: string | string[];
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
  // 宛先を配列へ正規化（重複・空を除去）。複数宛先に対応（#72）
  const recipients = [...new Set((Array.isArray(msg.to) ? msg.to : [msg.to]).map((t) => (t ?? '').trim()).filter(Boolean))];
  if (recipients.length === 0) return { ok: false, error: 'no recipient' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: recipients,
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

export interface DocumentEmailData {
  /** 'receipt' 領収書 / 'invoice' 請求書 */
  type: 'receipt' | 'invoice';
  documentNumber: string;
  bookingNumber: string;
  recipientName: string;
  total: number;
  /** 書類の閲覧URL（ログイン不要の公開トークンページ。PDF保存もここから） */
  url: string;
}

/** 領収書・請求書をメールで送るための本文（ログイン不要の閲覧リンク付き） */
export function documentEmail(d: DocumentEmailData): { subject: string; html: string; text: string } {
  const label = d.type === 'receipt' ? '領収書' : '請求書';
  const subject = `【レンタルスペースALBE】${label}のご案内（予約番号 ${d.bookingNumber}）`;
  const name = escapeHtml(d.recipientName || 'お客様');
  const html = `<div style="font-family:sans-serif;font-size:14px;color:#1a1a1a;line-height:1.8">
<p>${name} 様</p>
<p>レンタルスペースALBEをご利用いただきありがとうございます。<br>ご利用分の${label}を発行いたしましたので、下記よりご確認ください。</p>
<p style="margin:16px 0"><a href="${escapeHtml(d.url)}" style="display:inline-block;background:#1f6feb;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:700">${label}を開く</a></p>
<p style="font-size:13px;color:#6b7280">上のボタンが開かない場合は、次のURLをブラウザに貼り付けてください：<br><a href="${escapeHtml(d.url)}" style="color:#1d4ed8;word-break:break-all">${escapeHtml(d.url)}</a></p>
<table style="border-collapse:collapse;font-size:13px;margin-top:8px">
<tr><td style="color:#6b7280;padding:2px 10px 2px 0">${label}番号</td><td>${escapeHtml(d.documentNumber)}</td></tr>
<tr><td style="color:#6b7280;padding:2px 10px 2px 0">金額（税込）</td><td>${yen(d.total)}</td></tr>
</table>
<p style="font-size:13px;color:#6b7280;margin-top:14px">※このリンクはログイン不要でご覧いただけます。ページを開いて「PDFをダウンロード」または「印刷」からPDFとして保存できます。</p>
</div>`;
  const text = `${d.recipientName || 'お客様'} 様

レンタルスペースALBEをご利用いただきありがとうございます。
ご利用分の${label}を発行いたしました。下記URLよりご確認ください（ログイン不要）。

${label}：${d.url}

${label}番号：${d.documentNumber}
金額（税込）：${yen(d.total)}

※ページを開いて「PDFをダウンロード」または「印刷」からPDFとして保存できます。`;
  return withSignature({ subject, html, text });
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
  /** ご予約の確認・変更ページURL（#75。番号プリフィル込みで渡す） */
  changeUrl?: string;
  /** 請求書払いの場合 true（請求書の案内文を出す） */
  isInvoice?: boolean;
  /** 予約フォームの追加項目（利用目的・人数・過去利用・きっかけ 等）#60 */
  extras?: ReadonlyArray<{ label: string; value: string }>;
}

function daysBlockText(days: BookingEmailData['days']): string {
  return days.map((d) => `  ${d.date}  ${d.startTime}〜${d.endTime}`).join('\n');
}
function daysBlockHtml(days: BookingEmailData['days']): string {
  return days
    .map((d) => `<li>${escapeHtml(d.date)}　${escapeHtml(d.startTime)}〜${escapeHtml(d.endTime)}</li>`)
    .join('');
}

/** 追加項目ブロック（利用目的・人数・過去利用・きっかけ 等）#60 */
function extrasBlockText(extras?: BookingEmailData['extras']): string {
  const rows = (extras ?? []).filter((e) => e.value);
  if (!rows.length) return '';
  return '\n' + rows.map((e) => `${e.label}: ${e.value}`).join('\n');
}
function extrasRowsHtml(extras?: BookingEmailData['extras']): string {
  const rows = (extras ?? []).filter((e) => e.value);
  if (!rows.length) return '';
  return rows
    .map((e) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">${escapeHtml(e.label)}</td><td>${escapeHtml(e.value)}</td></tr>`)
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
イベント名: ${d.eventName}${extrasBlockText(d.extras)}
日時:
${daysBlockText(d.days)}
合計金額（税込）: ${yen(d.total)}
${
  d.mypageUrl
    ? `\n${d.isInvoice ? '請求書' : '領収書'}はマイページの「書類」からダウンロードいただけます。\n${d.mypageUrl}\n`
    : ''
}${d.changeUrl ? `\nご予約の確認・変更（日時変更・キャンセルのご相談）はこちら:\n${d.changeUrl}\n` : ''}
ご不明な点がございましたらお問い合わせください。`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>このたびはレンタルスペースALBEをご利用いただき、ありがとうございます。<br>以下の内容で<strong>${label}</strong>を承りました。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">イベント名</td><td>${escapeHtml(d.eventName)}</td></tr>
${extrasRowsHtml(d.extras)}
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
${
  d.changeUrl
    ? `<p style="margin:12px 0;font-size:14px">ご予約の確認・変更（日時変更・キャンセルのご相談）は<a href="${escapeHtml(d.changeUrl)}" style="color:#1d4ed8;font-weight:700">こちら ▶</a></p>`
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

/** お客様向け：差額の下に添える案内文（追加請求・返金いずれも担当者から別途連絡する旨） */
const DIFF_FOLLOWUP_NOTE = '※差額については別途ご連絡差し上げますので担当者からのメールをお待ちくださいませ。';

/** 金額の変更点ブロック（テキスト）。oldTotal指定かつ増減ありなら 変更前→変更後＋差額 */
function amountBlockText(d: RescheduleEmailData, forCustomer = false): string {
  if (!d.showAmount) return '';
  if (d.oldTotal !== undefined && d.oldTotal !== d.total) {
    const note = forCustomer ? `\n  ${DIFF_FOLLOWUP_NOTE}` : '';
    return `\n\n【お支払い金額の変更】\n  変更前（税込）: ${yen(d.oldTotal)}\n  変更後（税込）: ${yen(d.total)}\n  ${diffLabel(d.oldTotal, d.total)}${note}`;
  }
  return `\n\n変更後の合計金額（税込）: ${yen(d.total)}`;
}

/** 金額の変更点ブロック（HTML）。oldTotal指定かつ増減ありなら 変更前→変更後＋差額 */
function amountBlockHtml(d: RescheduleEmailData, forCustomer = false): string {
  if (!d.showAmount) return '';
  if (d.oldTotal !== undefined && d.oldTotal !== d.total) {
    const diff = d.total - d.oldTotal;
    const color = diff > 0 ? '#b45309' : '#15803d';
    const note = forCustomer ? `<p style="margin:6px 0 0;color:#6b7280;font-size:13px">${DIFF_FOLLOWUP_NOTE}</p>` : '';
    return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;margin:12px 0;background:#f9fafb">
<p style="margin:2px 0;color:#6b7280;font-size:13px">お支払い金額の変更</p>
<p style="margin:2px 0">変更前（税込）: <span style="color:#9ca3af;text-decoration:line-through">${yen(d.oldTotal)}</span></p>
<p style="margin:2px 0;font-size:18px">変更後（税込）: <strong>${yen(d.total)}</strong></p>
<p style="margin:4px 0 0;color:${color};font-weight:600">${diffLabel(d.oldTotal, d.total)}</p>
${note}</div>`;
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
  const amountText = amountBlockText(d, true);
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
  const amountHtml = amountBlockHtml(d, true);
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
イベント名: ${d.eventName}${extrasBlockText(d.extras)}
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
${extrasRowsHtml(d.extras)}
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

/** 追加料金のお支払いのお願い（予約内容変更で差額が発生したとき・顧客向け） */
export function additionalChargeEmail(d: {
  customerName: string;
  bookingNumber: string;
  spaceName: string;
  amount: number;
  payUrl: string;
  reason?: string;
}): { subject: string; html: string; text: string } {
  const subject = `【レンタルスペースALBE】追加料金のお支払いのお願い（${d.bookingNumber}）`;
  const reasonLine = d.reason ? `\n内容: ${d.reason}` : '';
  const text = `${d.customerName} 様

ご予約の内容変更にともない、追加のお支払いが発生いたしました。
お手数ですが、下記のお支払いページよりお手続きをお願いいたします。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
追加金額（税込）: ${yen(d.amount)}${reasonLine}

お支払いページ:
${d.payUrl}

※ページではクレジットカードのほか、対象スペースでご利用可能なお支払い方法をお選びいただけます。
※お支払いの確認をもって、変更後のご予約が確定いたします。`;
  const reasonHtml = d.reason ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">内容</td><td>${escapeHtml(d.reason)}</td></tr>` : '';
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>ご予約の内容変更にともない、<strong>追加のお支払い</strong>が発生いたしました。<br>お手数ですが、下記のお支払いページよりお手続きをお願いいたします。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
${reasonHtml}
</table>
<p style="font-size:18px">追加金額（税込）: <strong>${yen(d.amount)}</strong></p>
<p style="margin:14px 0"><a href="${escapeHtml(d.payUrl)}" style="display:inline-block;background:#0068b7;color:#fff;padding:12px 20px;border-radius:8px;font-weight:700;text-decoration:none">お支払いページへ進む ▶</a></p>
<p style="color:#6b7280;font-size:13px">※ページではクレジットカードのほか、対象スペースでご利用可能なお支払い方法をお選びいただけます。<br>※お支払いの確認をもって、変更後のご予約が確定いたします。</p>
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

/** 支払い方法＋入金状況のラベル（返金処理の判断材料）#64 */
export function paymentMethodStatusLabel(method: string | null, status?: string | null): string {
  const m =
    ({ stripe: 'Stripe（カード・Apple Pay・コンビニ）', paypal: 'PayPal', bank_transfer: '銀行振込（Stripe収納代行）', invoice: '請求書払い' } as Record<string, string>)[method ?? ''] ||
    method ||
    '不明';
  if (!status) return m;
  const s = ({ paid: '入金済み', unpaid: '未入金', invoice: '請求書払い（未収）' } as Record<string, string>)[status] || status;
  return `${m}（${s}）`;
}

/**
 * 管理者向け：返金／追加請求の対応要アラート（#62/#63/#64）。
 * 予約変更で差額が出た場合・キャンセルで返金が生じる場合のみ発信する
 * （料金変動なし・返金ゼロのときは呼び出さない）。支払い方法と入金状況を明記し、
 * 返金処理をどう行えばよいか一目で分かるようにする。
 */
export function adminPaymentActionAlertEmail(d: {
  kind: 'reschedule' | 'cancel';
  action: 'surcharge' | 'refund'; // 追加請求 or 返金
  amount: number; // 対応が必要な金額（絶対値・税込）
  bookingNumber: string;
  spaceName: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  paymentMethod: string | null;
  paymentStatus?: string | null;
  oldTotal?: number; // reschedule
  newTotal?: number; // reschedule
  cancelFee?: number; // cancel
  paidAmount?: number; // cancel（既収金額）
  adminUrl?: string;
}): { subject: string; html: string; text: string } {
  const actionLabel = d.action === 'surcharge' ? '追加請求' : '返金';
  const kindLabel = d.kind === 'reschedule' ? '予約変更' : 'キャンセル';
  const payLabel = paymentMethodStatusLabel(d.paymentMethod, d.paymentStatus);
  const subject = `【要対応・${actionLabel}】${actionLabel} ${yen(d.amount)}／${kindLabel}（${d.bookingNumber}）`;

  // 内訳（変更 or キャンセルで出し分け）
  const breakdownLines: string[] = [];
  if (d.kind === 'reschedule' && d.oldTotal != null && d.newTotal != null) {
    breakdownLines.push(`変更前の合計（税込）: ${yen(d.oldTotal)}`);
    breakdownLines.push(`変更後の合計（税込）: ${yen(d.newTotal)}`);
  }
  if (d.kind === 'cancel') {
    if (d.paidAmount != null) breakdownLines.push(`既収金額（税込）: ${yen(d.paidAmount)}`);
    if (d.cancelFee != null) breakdownLines.push(`キャンセル料（税込）: ${yen(d.cancelFee)}`);
  }
  const contact = d.customerEmail ? `${d.customerName}（${d.customerEmail}${d.customerPhone ? ' / ' + d.customerPhone : ''}）` : d.customerName;
  const guide =
    d.action === 'refund'
      ? '※返金が必要です。上記の支払い方法・入金状況をご確認のうえ、返金処理をお願いします。未入金の場合は請求額の調整で対応してください。'
      : '※追加のお支払いが必要です。支払い方法・入金状況をご確認のうえ、追加請求の手続きをお願いします。';

  const text = `${kindLabel}にともない、${actionLabel}の対応が必要です。

■ ${actionLabel}金額（税込）: ${yen(d.amount)}

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
お客様: ${contact}
支払い方法: ${payLabel}
${breakdownLines.length ? '\n【内訳】\n' + breakdownLines.map((l) => '  ' + l).join('\n') + '\n' : ''}
${guide}${d.adminUrl ? `\n\n管理画面: ${d.adminUrl}` : ''}`;

  const amountColor = d.action === 'surcharge' ? '#b45309' : '#15803d';
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p><strong>${escapeHtml(kindLabel)}</strong>にともない、<strong style="color:${amountColor}">${escapeHtml(actionLabel)}の対応が必要</strong>です。</p>
<p style="font-size:20px;margin:8px 0;color:${amountColor}"><strong>${escapeHtml(actionLabel)} ${yen(d.amount)}</strong></p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">お客様</td><td>${escapeHtml(contact)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">支払い方法</td><td><strong>${escapeHtml(payLabel)}</strong></td></tr>
</table>
${breakdownLines.length ? '<p style="margin:6px 0;color:#6b7280">内訳</p><ul style="margin:4px 0">' + breakdownLines.map((l) => '<li>' + escapeHtml(l) + '</li>').join('') + '</ul>' : ''}
<p style="background:#fff8e6;border:1px solid #f0c36d;color:#a15c00;border-radius:8px;padding:10px 14px;font-size:13px">${escapeHtml(guide)}</p>
${d.adminUrl ? `<p style="margin:16px 0"><a href="${escapeHtml(d.adminUrl)}" style="display:inline-block;background:#1f6feb;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none">管理画面で確認</a></p>` : ''}
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
  /** ご予約の確認・変更ページURL（#75・番号プリフィル込み） */
  changeUrl?: string;
}): { subject: string; html: string; text: string } {
  const whenSubject = d.daysBefore === 1 ? '明日ご利用' : `ご利用${d.daysBefore}日前`;
  const subject = `【レンタルスペースALBE】${whenSubject}のご予約リマインダー（${d.bookingNumber}）`;
  const leadText =
    d.daysBefore === 1
      ? 'ご利用日は明日です。ご予約内容をお知らせいたします。'
      : `ご利用日まであと${d.daysBefore}日となりました。ご予約内容をお知らせいたします。`;
  const leadHtml =
    d.daysBefore === 1
      ? 'ご利用日は<strong>明日</strong>です。ご予約内容をお知らせいたします。'
      : `ご利用日まで<strong>あと${d.daysBefore}日</strong>となりました。ご予約内容をお知らせいたします。`;
  const text = `${d.customerName} 様

${leadText}

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
イベント名: ${d.eventName}
日時:
${daysBlockText(d.days)}
${d.changeUrl ? `\nご予約の確認・変更（日時変更・キャンセルのご相談）はこちら:\n${d.changeUrl}\n` : ''}
当日のご来店をお待ちしております。ご不明な点がございましたらお問い合わせください。`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>${leadHtml}</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">イベント名</td><td>${escapeHtml(d.eventName)}</td></tr>
</table>
<p style="margin:6px 0;color:#6b7280">日時</p>
<ul style="margin:4px 0">${daysBlockHtml(d.days)}</ul>
${d.changeUrl ? `<p style="margin:12px 0;font-size:14px">ご予約の確認・変更（日時変更・キャンセルのご相談）は<a href="${escapeHtml(d.changeUrl)}" style="color:#1d4ed8;font-weight:700">こちら ▶</a></p>` : ''}
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
  /** 今回のご利用で付与したポイント（会員・0超のときのみ案内を表示）#70 */
  pointsEarned?: number;
  /** 付与後の保有ポイント */
  pointBalance?: number;
}): { subject: string; html: string; text: string } {
  const subject = `【レンタルスペースALBE】ご利用ありがとうございました`;
  const showPoints = typeof d.pointsEarned === 'number' && d.pointsEarned > 0;
  const balanceText = typeof d.pointBalance === 'number' ? `（現在の保有ポイント：${d.pointBalance}P）` : '';
  const pointsText = showPoints
    ? `\n今回のご利用で ${d.pointsEarned}ポイント を付与いたしました。${balanceText}
1ポイント=1円で、次回以降のご予約にご利用いただけます。\n`
    : '';
  const text = `${d.customerName} 様

先日は「${d.spaceName}」をご利用いただき、誠にありがとうございました。
またのご利用を心よりお待ちしております。
${pointsText}${d.bookingUrl ? `\nご予約はこちら：\n${d.bookingUrl}\n` : ''}
ご意見・ご要望がございましたら、お気軽にお問い合わせください。`;
  const pointsHtml = showPoints
    ? `<div style="background:#eef6ee;border:1px solid #cfe6cf;border-radius:8px;padding:12px 14px;margin:14px 0;font-size:14px;color:#166534">今回のご利用で <strong>${d.pointsEarned}ポイント</strong> を付与いたしました。${typeof d.pointBalance === 'number' ? `<br>現在の保有ポイント：<strong>${d.pointBalance}P</strong>` : ''}<br><span style="color:#3f6b47">1ポイント=1円で、次回以降のご予約にご利用いただけます。</span></div>`
    : '';
  const btn = d.bookingUrl
    ? `<p style="margin:16px 0"><a href="${escapeHtml(d.bookingUrl)}" style="display:inline-block;background:#1f6feb;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none">次回のご予約はこちら</a></p>`
    : '';
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>先日は「<strong>${escapeHtml(d.spaceName)}</strong>」をご利用いただき、誠にありがとうございました。<br>またのご利用を心よりお待ちしております。</p>
${pointsHtml}${btn}
<p style="color:#6b7280;font-size:13px">ご意見・ご要望がございましたら、お気軽にお問い合わせください。</p>
</div>`;
  return withSignature({ subject, html, text });
}

/** ポイント有効期限が近づいている会員へのお知らせ（#78） */
export function pointExpiryNoticeEmail(d: {
  customerName: string;
  pointBalance: number;
  expiryDate: string; // 'YYYY-MM-DD'
  bookingUrl?: string;
}): { subject: string; html: string; text: string } {
  const [y, m, day] = d.expiryDate.split('-');
  const dateLabel = `${y}年${Number(m)}月${Number(day)}日`;
  const subject = `【レンタルスペースALBE】ポイント有効期限のお知らせ（${d.pointBalance}P・${dateLabel}まで）`;
  const text = `${d.customerName} 様

現在お持ちのポイント（${d.pointBalance}P）の有効期限が近づいております。

有効期限: ${dateLabel} まで

ポイントは1ポイント=1円で、ご予約時にご利用いただけます。
また、期限までに新たなご利用があれば、有効期限は最終ご利用日から1年間に延長されます。
${d.bookingUrl ? `\nご予約はこちら：\n${d.bookingUrl}\n` : ''}
ご不明な点がございましたら、お気軽にお問い合わせください。`;
  const btn = d.bookingUrl
    ? `<p style="margin:16px 0"><a href="${escapeHtml(d.bookingUrl)}" style="display:inline-block;background:#1f6feb;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none">ご予約はこちら</a></p>`
    : '';
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>現在お持ちのポイント（<strong>${d.pointBalance}P</strong>）の有効期限が近づいております。</p>
<div style="background:#fff8e6;border:1px solid #f0c36d;border-radius:8px;padding:12px 14px;margin:12px 0;font-size:15px;color:#8a5a00">有効期限：<strong>${dateLabel}</strong> まで</div>
<p>ポイントは1ポイント=1円で、ご予約時にご利用いただけます。<br>また、期限までに新たなご利用があれば、有効期限は<strong>最終ご利用日から1年間</strong>に延長されます。</p>
${btn}
<p style="color:#6b7280;font-size:13px">ご不明な点がございましたら、お気軽にお問い合わせください。</p>
</div>`;
  return withSignature({ subject, html, text });
}

// ---------------------------------------------------------------------------
// 予約変更リクエスト（マイページ発／管理者承認制）#54
// ---------------------------------------------------------------------------

/** 変更リクエスト種別の日本語ラベル */
export function changeRequestTypeLabel(type: string): string {
  return (
    { reschedule: '日時変更のご希望', option: 'オプション変更のご希望', cancel: 'キャンセルのご希望', other: 'その他のご相談' } as Record<string, string>
  )[type] ?? 'ご相談';
}

/** 変更リクエスト受付（お客様宛の確認メール） */
export function changeRequestReceivedEmail(d: {
  customerName: string;
  bookingNumber: string;
  spaceName: string;
  type: string;
  message: string;
  proposedDays?: ReadonlyArray<{ date: string; startTime: string; endTime: string }>;
}): { subject: string; html: string; text: string } {
  const label = changeRequestTypeLabel(d.type);
  const subject = `【レンタルスペースALBE】変更リクエストを受け付けました（${d.bookingNumber}）`;
  const proposed = d.proposedDays && d.proposedDays.length ? `\n\n【ご希望の日時】\n${daysBlockText(d.proposedDays)}` : '';
  const text = `${d.customerName} 様

ご予約に関する変更リクエストを受け付けました。
担当者が内容を確認し、追ってご連絡いたします。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
ご相談内容: ${label}
${d.message ? `\nご連絡事項:\n${d.message}` : ''}${proposed}

※このリクエストは「受付」の段階です。担当者の承認をもって変更が確定します。
※承認・確定の際は、あらためてメールでお知らせいたします。`;
  const proposedHtml = d.proposedDays && d.proposedDays.length
    ? `<p style="margin:6px 0;color:#6b7280">ご希望の日時</p><ul style="margin:4px 0">${daysBlockHtml(d.proposedDays)}</ul>`
    : '';
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>ご予約に関する変更リクエストを受け付けました。<br>担当者が内容を確認し、追ってご連絡いたします。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">ご相談内容</td><td>${escapeHtml(label)}</td></tr>
</table>
${d.message ? `<p style="margin:6px 0;color:#6b7280">ご連絡事項</p><p style="white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px">${escapeHtml(d.message)}</p>` : ''}
${proposedHtml}
<p style="color:#6b7280;font-size:13px">※このリクエストは「受付」の段階です。担当者の承認をもって変更が確定します。承認・確定の際は、あらためてメールでお知らせいたします。</p>
</div>`;
  return withSignature({ subject, html, text });
}

/** 変更リクエスト通知（管理者宛） */
export function adminChangeRequestEmail(d: {
  bookingNumber: string;
  spaceName: string;
  eventName: string;
  type: string;
  message: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  proposedDays?: ReadonlyArray<{ date: string; startTime: string; endTime: string }>;
  adminUrl?: string;
}): { subject: string; html: string; text: string } {
  const label = changeRequestTypeLabel(d.type);
  const subject = `【変更リクエスト】${label}／${d.spaceName}（${d.bookingNumber}）`;
  const proposed = d.proposedDays && d.proposedDays.length ? `\n\n【ご希望の日時】\n${daysBlockText(d.proposedDays)}` : '';
  const contact = d.customerEmail ? `${d.customerName}（${d.customerEmail}${d.customerPhone ? ' / ' + d.customerPhone : ''}）` : d.customerName;
  const text = `お客様から予約変更リクエストが届きました。
管理画面の「変更リクエスト」から内容を確認し、承認または却下してください。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
イベント名: ${d.eventName}
お客様: ${contact}
ご相談内容: ${label}

ご連絡事項:
${d.message}${proposed}
${d.adminUrl ? `\n管理画面: ${d.adminUrl}` : ''}`;
  const proposedHtml = d.proposedDays && d.proposedDays.length
    ? `<p style="margin:6px 0;color:#6b7280">ご希望の日時</p><ul style="margin:4px 0">${daysBlockHtml(d.proposedDays)}</ul>`
    : '';
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>お客様から<strong>予約変更リクエスト</strong>が届きました。<br>管理画面の「変更リクエスト」から内容を確認し、承認または却下してください。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td><strong>${escapeHtml(d.bookingNumber)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">イベント名</td><td>${escapeHtml(d.eventName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">お客様</td><td>${escapeHtml(contact)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">ご相談内容</td><td>${escapeHtml(label)}</td></tr>
</table>
<p style="margin:6px 0;color:#6b7280">ご連絡事項</p>
<p style="white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px">${escapeHtml(d.message)}</p>
${proposedHtml}
${d.adminUrl ? `<p style="margin:16px 0"><a href="${escapeHtml(d.adminUrl)}" style="display:inline-block;background:#1f6feb;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none">管理画面で確認</a></p>` : ''}
</div>`;
  return withSignature({ subject, html, text });
}

/** 変更リクエスト却下（お客様宛） */
export function changeRequestRejectedEmail(d: {
  customerName: string;
  bookingNumber: string;
  spaceName: string;
  adminNote?: string;
}): { subject: string; html: string; text: string } {
  const subject = `【レンタルスペースALBE】変更リクエストについて（${d.bookingNumber}）`;
  const text = `${d.customerName} 様

ご予約（${d.bookingNumber}／${d.spaceName}）について、変更リクエストを承りましたが、
今回はご希望に沿った変更が難しい状況です。
${d.adminNote ? `\n【担当者より】\n${d.adminNote}\n` : ''}
ご不明な点やご希望の再調整については、お気軽にお問い合わせください。
現在のご予約はそのまま有効です。`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>ご予約（<strong>${escapeHtml(d.bookingNumber)}</strong>／${escapeHtml(d.spaceName)}）について、変更リクエストを承りましたが、今回はご希望に沿った変更が難しい状況です。</p>
${d.adminNote ? `<p style="margin:6px 0;color:#6b7280">担当者より</p><p style="white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px">${escapeHtml(d.adminNote)}</p>` : ''}
<p>ご不明な点やご希望の再調整については、お気軽にお問い合わせください。<br>現在のご予約はそのまま有効です。</p>
</div>`;
  return withSignature({ subject, html, text });
}

// ---------------------------------------------------------------------------
// 決済先行フローの「不成立・返金」通知（#68）
// ---------------------------------------------------------------------------

/** 予約不成立（満室）・返金のお知らせ（お客様宛） */
export function bookingFailedEmail(d: {
  customerName: string;
  bookingNumber: string;
  spaceName: string;
  days: ReadonlyArray<{ date: string; startTime: string; endTime: string }>;
  total: number;
  paymentMethod: string;
}): { subject: string; html: string; text: string } {
  const subject = `【レンタルスペースALBE】ご予約が成立しませんでした（ご返金いたします）`;
  const refundNote =
    d.paymentMethod === 'paypal'
      ? 'PayPalでのお支払いは確定しておりませんので、ご請求は発生いたしません。'
      : 'お支払いいただいた代金は全額ご返金いたします（クレジットカードの場合、数日〜1週間程度で明細に反映されます）。';
  const text = `${d.customerName} 様

このたびは「${d.spaceName}」へのご予約をいただき、ありがとうございました。
大変申し訳ございませんが、ご決済の直前に他のお客様のご予約が確定したため、
下記のご予約は成立いたしませんでした。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
ご希望日時:
${daysBlockText(d.days)}
金額（税込）: ${yen(d.total)}

${refundNote}

ご不便をおかけし誠に申し訳ございません。別の日時・スペースでのご予約を
心よりお待ちしております。`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>このたびは「<strong>${escapeHtml(d.spaceName)}</strong>」へのご予約をいただき、ありがとうございました。<br>
大変申し訳ございませんが、ご決済の直前に他のお客様のご予約が確定したため、下記のご予約は<strong>成立いたしませんでした</strong>。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td>${escapeHtml(d.bookingNumber)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">金額（税込）</td><td>${yen(d.total)}</td></tr>
</table>
<p style="margin:6px 0;color:#6b7280">ご希望日時</p>
<ul style="margin:4px 0">${daysBlockHtml(d.days)}</ul>
<p style="background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:8px;padding:10px 14px">${escapeHtml(refundNote)}</p>
<p style="color:#6b7280;font-size:13px">ご不便をおかけし誠に申し訳ございません。別の日時・スペースでのご予約を心よりお待ちしております。</p>
</div>`;
  return withSignature({ subject, html, text });
}

/** 予約不成立（満室）・返金の管理者通知 */
export function adminBookingFailedEmail(d: {
  bookingNumber: string;
  spaceName: string;
  days: ReadonlyArray<{ date: string; startTime: string; endTime: string }>;
  total: number;
  paymentMethod: string;
  customerName: string;
  customerEmail?: string;
  refundOk: boolean;
}): { subject: string; html: string; text: string } {
  const subject = `【予約不成立・返金】${d.spaceName}（${d.bookingNumber}）`;
  const payLbl = paymentMethodStatusLabel(d.paymentMethod);
  const refundLine = d.paymentMethod === 'paypal'
    ? 'PayPal：未キャプチャのため課金なし（対応不要）'
    : d.refundOk
      ? '返金：自動返金を実行しました（Stripe）'
      : '返金：⚠自動返金に失敗しました。Stripe管理画面から手動で返金してください。';
  const contact = d.customerEmail ? `${d.customerName}（${d.customerEmail}）` : d.customerName;
  const text = `決済は成立しましたが、枠が埋まっていたため予約は不成立です。

予約番号: ${d.bookingNumber}
スペース: ${d.spaceName}
日時:
${daysBlockText(d.days)}
金額（税込）: ${yen(d.total)}
支払い方法: ${payLbl}
お客様: ${contact}

${refundLine}`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p><strong>決済は成立しましたが、枠が埋まっていたため予約は不成立</strong>です。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">予約番号</td><td>${escapeHtml(d.bookingNumber)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">スペース</td><td>${escapeHtml(d.spaceName)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">金額（税込）</td><td>${yen(d.total)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">支払い方法</td><td>${escapeHtml(payLbl)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">お客様</td><td>${escapeHtml(contact)}</td></tr>
</table>
<p style="margin:6px 0;color:#6b7280">日時</p>
<ul style="margin:4px 0">${daysBlockHtml(d.days)}</ul>
<p style="background:${d.refundOk || d.paymentMethod === 'paypal' ? '#f0fdf4' : '#fff8e6'};border:1px solid ${d.refundOk || d.paymentMethod === 'paypal' ? '#bbf7d0' : '#f0c36d'};border-radius:8px;padding:10px 14px">${escapeHtml(refundLine)}</p>
</div>`;
  return withSignature({ subject, html, text });
}

// ===== 見学申込メール（#81） =====

const VIEWING_BOOKING_STATUS_LABEL: Record<string, string> = {
  booked: '予約済み',
  considering: '予約検討中',
  other: 'その他',
};

export interface ViewingRequestEmailData {
  customerName: string;
  spaceNames: string;                 // 例：アルベホール名古屋 / 名駅フリースペース
  mode: 'slot' | 'propose';
  /** モードA：希望日時（第一・第二） */
  choices?: ReadonlyArray<{ label: string; date: string; start: string }>;
  /** モードB：おおよその希望時期 */
  desiredPeriod?: string;
  purpose?: string;
  note?: string;
}

/** 見学申込 受付メール（お客様向け・自動返信） */
export function viewingReceivedEmail(d: ViewingRequestEmailData): { subject: string; html: string; text: string } {
  const subject = '【レンタルスペースALBE】見学のお申し込みを受け付けました';
  const wishText =
    d.mode === 'slot' && d.choices?.length
      ? `\n【ご希望日時】\n${d.choices.map((c) => `${c.label}：${c.date} ${c.start}〜（見学30分）`).join('\n')}`
      : `\n【おおよそのご希望時期】\n${d.desiredPeriod ?? ''}\n※空き状況を確認のうえ、こちらから候補日時をご提案いたします。`;
  const text = `${d.customerName} 様

この度は、レンタルスペースALBEの見学をお申し込みいただきありがとうございます。
下記の内容で受け付けいたしました。担当者が空き状況と対応可否を確認し、追ってご連絡いたします。

【見学希望のスペース】
${d.spaceNames}${wishText}
${d.purpose ? `\n【利用目的】\n${d.purpose}` : ''}${d.note ? `\n\n【ご質問・ご要望】\n${d.note}` : ''}

※このメールは「受付」の段階です。見学日時の確定は、あらためてメールでお知らせいたします。
※ご予約状況の変化により、ご希望に添えない場合は代替日をご案内いたします。`;
  const choicesHtml =
    d.mode === 'slot' && d.choices?.length
      ? `<p style="margin:6px 0;color:#6b7280">ご希望日時</p><ul style="margin:4px 0">${d.choices
          .map((c) => `<li>${escapeHtml(c.label)}：${escapeHtml(c.date)} ${escapeHtml(c.start)}〜（見学30分）</li>`)
          .join('')}</ul>`
      : `<p style="margin:6px 0;color:#6b7280">おおよそのご希望時期</p><p style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px">${escapeHtml(
          d.desiredPeriod ?? '',
        )}</p><p style="color:#6b7280;font-size:13px">※空き状況を確認のうえ、こちらから候補日時をご提案いたします。</p>`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>この度は、レンタルスペースALBEの見学をお申し込みいただきありがとうございます。<br>下記の内容で受け付けいたしました。担当者が空き状況と対応可否を確認し、追ってご連絡いたします。</p>
<p style="margin:6px 0;color:#6b7280">見学希望のスペース</p>
<p style="font-weight:600">${escapeHtml(d.spaceNames)}</p>
${choicesHtml}
${d.purpose ? `<p style="margin:6px 0;color:#6b7280">利用目的</p><p>${escapeHtml(d.purpose)}</p>` : ''}
${d.note ? `<p style="margin:6px 0;color:#6b7280">ご質問・ご要望</p><p style="white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px">${escapeHtml(d.note)}</p>` : ''}
<p style="color:#6b7280;font-size:13px">※このメールは「受付」の段階です。見学日時の確定は、あらためてメールでお知らせいたします。<br>※ご予約状況の変化により、ご希望に添えない場合は代替日をご案内いたします。</p>
</div>`;
  return withSignature({ subject, html, text });
}

/** 見学申込 通知メール（スタッフ向け） */
export function adminViewingRequestEmail(
  d: ViewingRequestEmailData & { email: string; phone: string; orgName?: string; bookingStatus?: string; adminUrl?: string },
): { subject: string; html: string; text: string } {
  const subject = `【見学申込】${d.spaceNames}｜${d.customerName} 様`;
  const wishText =
    d.mode === 'slot' && d.choices?.length
      ? `ご希望日時：\n${d.choices.map((c) => `  ${c.label}：${c.date} ${c.start}〜`).join('\n')}`
      : `おおよその希望時期：${d.desiredPeriod ?? ''}（→こちらから候補提案）`;
  const bs = d.bookingStatus ? VIEWING_BOOKING_STATUS_LABEL[d.bookingStatus] ?? d.bookingStatus : '';
  const text = `見学の申し込みが入りました。

お客様：${d.customerName}
メール：${d.email}
電話　：${d.phone}
${d.orgName ? `会社/学校/団体：${d.orgName}\n` : ''}見学希望スペース：${d.spaceNames}
受付方式：${d.mode === 'slot' ? '空き枠選択' : '希望時期→候補提案'}
${wishText}
${d.purpose ? `利用目的：${d.purpose}\n` : ''}${bs ? `現在の予約状況：${bs}\n` : ''}${d.note ? `\nご質問・ご要望：\n${d.note}\n` : ''}
${d.adminUrl ? `\n▼管理画面（見学タブ）で確定/提案してください\n${d.adminUrl}` : '\n管理画面「見学」タブで確定/提案してください。'}`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>見学の申し込みが入りました。</p>
<table style="border-collapse:collapse;margin:8px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">お客様</td><td><strong>${escapeHtml(d.customerName)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">メール</td><td>${escapeHtml(d.email)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">電話</td><td>${escapeHtml(d.phone)}</td></tr>
${d.orgName ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">会社/学校/団体</td><td>${escapeHtml(d.orgName)}</td></tr>` : ''}
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">見学希望スペース</td><td>${escapeHtml(d.spaceNames)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">受付方式</td><td>${d.mode === 'slot' ? '空き枠選択' : '希望時期→候補提案'}</td></tr>
${d.purpose ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">利用目的</td><td>${escapeHtml(d.purpose)}</td></tr>` : ''}
${bs ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">現在の予約状況</td><td>${escapeHtml(bs)}</td></tr>` : ''}
</table>
${
  d.mode === 'slot' && d.choices?.length
    ? `<p style="margin:6px 0;color:#6b7280">ご希望日時</p><ul style="margin:4px 0">${d.choices.map((c) => `<li>${escapeHtml(c.label)}：${escapeHtml(c.date)} ${escapeHtml(c.start)}〜</li>`).join('')}</ul>`
    : `<p style="margin:6px 0;color:#6b7280">おおよその希望時期</p><p style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px">${escapeHtml(d.desiredPeriod ?? '')}</p>`
}
${d.note ? `<p style="margin:6px 0;color:#6b7280">ご質問・ご要望</p><p style="white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px">${escapeHtml(d.note)}</p>` : ''}
${d.adminUrl ? `<p style="margin-top:12px"><a href="${escapeHtml(d.adminUrl)}" style="color:#1d4ed8">管理画面（見学タブ）で確定/提案する</a></p>` : '<p style="color:#6b7280">管理画面「見学」タブで確定/提案してください。</p>'}
</div>`;
  return withSignature({ subject, html, text });
}

/** 見学 候補日時のご提案（お客様向け・モードB等） */
export function viewingProposedEmail(d: {
  customerName: string;
  spaceNames: string;
  date: string;
  start: string;
  end: string;
  staffNote?: string;
}): { subject: string; html: string; text: string } {
  const subject = '【レンタルスペースALBE】見学の候補日時をご提案します';
  const text = `${d.customerName} 様

見学について、下記の日時でご案内が可能です。ご都合はいかがでしょうか。

【見学スペース】${d.spaceNames}
【候補日時】${d.date} ${d.start}〜${d.end}（見学30分程度）
${d.staffNote ? `\n${d.staffNote}\n` : ''}
ご都合が合う場合は、このメールにご返信ください。
別の日時をご希望の場合も、ご遠慮なくお知らせください。`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>見学について、下記の日時でご案内が可能です。ご都合はいかがでしょうか。</p>
<table style="border-collapse:collapse;margin:8px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">見学スペース</td><td>${escapeHtml(d.spaceNames)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">候補日時</td><td><strong>${escapeHtml(d.date)} ${escapeHtml(d.start)}〜${escapeHtml(d.end)}</strong>（見学30分程度）</td></tr>
</table>
${d.staffNote ? `<p style="white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px">${escapeHtml(d.staffNote)}</p>` : ''}
<p>ご都合が合う場合は、このメールにご返信ください。別の日時をご希望の場合も、ご遠慮なくお知らせください。</p>
</div>`;
  return withSignature({ subject, html, text });
}

/** 見学 確定メール（お客様向け） */
export function viewingConfirmedEmail(d: {
  customerName: string;
  spaceNames: string;
  date: string;
  start: string;
  end: string;
  staffNote?: string;
}): { subject: string; html: string; text: string } {
  const subject = '【レンタルスペースALBE】見学日時が確定しました';
  const text = `${d.customerName} 様

見学の日時が下記のとおり確定しました。当日はどうぞお気をつけてお越しください。

【見学スペース】${d.spaceNames}
【確定日時】${d.date} ${d.start}〜${d.end}（見学30分程度）
${d.staffNote ? `\n${d.staffNote}\n` : ''}
ご不明点やご変更のご希望がございましたら、このメールにご返信ください。
当日お会いできますことを楽しみにしております。`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>見学の日時が下記のとおり確定しました。当日はどうぞお気をつけてお越しください。</p>
<table style="border-collapse:collapse;margin:8px 0">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">見学スペース</td><td>${escapeHtml(d.spaceNames)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">確定日時</td><td><strong>${escapeHtml(d.date)} ${escapeHtml(d.start)}〜${escapeHtml(d.end)}</strong>（見学30分程度）</td></tr>
</table>
${d.staffNote ? `<p style="white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px">${escapeHtml(d.staffNote)}</p>` : ''}
<p>ご不明点やご変更のご希望がございましたら、このメールにご返信ください。当日お会いできますことを楽しみにしております。</p>
</div>`;
  return withSignature({ subject, html, text });
}

/** 見学 お断り／再調整のご案内（お客様向け） */
export function viewingDeclinedEmail(d: {
  customerName: string;
  spaceNames: string;
  staffNote?: string;
}): { subject: string; html: string; text: string } {
  const subject = '【レンタルスペースALBE】見学のお申し込みについて';
  const text = `${d.customerName} 様

この度は見学をお申し込みいただきありがとうございました。
誠に恐れ入りますが、ご希望の日時でのご案内が難しい状況です。
${d.staffNote ? `\n${d.staffNote}\n` : ''}
別の日時であればご案内できる場合がございます。お手数ですが、あらためてご希望の時期をお知らせいただけますと幸いです。
何卒よろしくお願いいたします。`;
  const html = `<div style="font-family:sans-serif;line-height:1.7;color:#1f2937">
<p>${escapeHtml(d.customerName)} 様</p>
<p>この度は見学をお申し込みいただきありがとうございました。<br>誠に恐れ入りますが、ご希望の日時でのご案内が難しい状況です。</p>
<p style="margin:6px 0;color:#6b7280">見学スペース：${escapeHtml(d.spaceNames)}</p>
${d.staffNote ? `<p style="white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px">${escapeHtml(d.staffNote)}</p>` : ''}
<p>別の日時であればご案内できる場合がございます。お手数ですが、あらためてご希望の時期をお知らせいただけますと幸いです。何卒よろしくお願いいたします。</p>
</div>`;
  return withSignature({ subject, html, text });
}
