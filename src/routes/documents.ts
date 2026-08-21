import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  getDocumentByToken,
  getBookingSummaryForGroup,
  getCustomerProfile,
  getIssuerInfo,
} from '../db/repository';
import { renderDocumentHtml, type DocumentData } from '../lib/documents';
import { sendEmail, documentEmail } from '../lib/email';

const app = new Hono<AppBindings>();

const isValidEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** 書類の閲覧URL（ログイン不要の公開トークンページ）を絶対URLで組み立てる */
function documentUrl(c: { req: { url: string }; env: { PUBLIC_BASE_URL?: string } }, token: string): string {
  const base = (c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(/\/$/, '');
  return `${base}/api/documents/${token}`;
}

const PAY_LABEL: Record<string, string> = {
  stripe: 'クレジットカード等（Stripe）',
  paypal: 'PayPal',
  bank_transfer: '銀行振込（Stripe収納代行）',
  invoice: '銀行振込（請求書払い）',
};

/**
 * GET /api/documents/:token  請求書・領収書の表示（印刷→PDF保存用）
 * public_token による閲覧のため認証不要（トークンが推測不可能な秘匿値）。
 */
app.get('/:token', async (c) => {
  const token = c.req.param('token');
  const doc = await getDocumentByToken(c.env.DB, token);
  if (!doc) {
    return c.html('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;text-align:center;color:#374151">書類が見つかりませんでした。URLをご確認ください。</body>', 404);
  }

  const [summary, customer, issuer] = await Promise.all([
    getBookingSummaryForGroup(c.env.DB, doc.group_id),
    getCustomerProfile(c.env.DB, doc.customer_id),
    getIssuerInfo(c.env.DB),
  ]);
  // 宛名：請求書名 > 会社名 > 氏名
  const invoiceName = await c.env.DB.prepare('SELECT invoice_name FROM booking_groups WHERE id = ?')
    .bind(doc.group_id)
    .first<{ invoice_name: string | null }>();
  const cust = customer as { company_name?: string; contact_name?: string } | null;
  // 宛名：請求書名（指定時）> 申込者の個人名（未指定時の既定）> 会社名 の順（#41）
  const recipientName =
    (invoiceName?.invoice_name || '').trim() ||
    (cust?.contact_name || '').trim() ||
    (cust?.company_name || '').trim() ||
    'お客様';

  const data: DocumentData = {
    type: doc.type,
    documentNumber: doc.booking_number + (doc.type === 'receipt' ? '-RCP' : '-INV'),
    issuedDate: (doc.issued_at || '').slice(0, 10),
    bookingNumber: doc.booking_number,
    recipientName,
    spaceName: summary?.spaceName || '',
    eventName: summary?.eventName || '',
    items: summary?.items || [],
    total: doc.total_amount,
    paymentMethodLabel: PAY_LABEL[summary?.paymentMethod || ''] || summary?.paymentMethod || '—',
    issuer: {
      name: issuer.name,
      zip: issuer.zip,
      address: issuer.address,
      tel: issuer.tel,
      email: issuer.email,
      invoiceRegNo: issuer.invoiceRegNo,
      bankInfo: issuer.bankInfo,
      note: issuer.note,
    },
  };

  // サーバー側PDF生成が使えるとき（CFクレデンシャル設定時）だけダウンロードボタンを出す
  const pdfEnabled = !!(c.env.CF_ACCOUNT_ID && c.env.CF_BROWSER_API_TOKEN);
  const format = c.req.query('format');

  // ?format=pdf：Browser Rendering REST API で本物のPDFを生成して返す。
  // スマホのアプリ内ブラウザ（window.print()が効かない）でも確実に保存できる。
  if (format === 'pdf' && pdfEnabled) {
    try {
      // 実ページ（?format=html）をブラウザで開かせることで、社印・フォント等の
      // アセットもそのまま反映させる（htmlを直接渡すと /assets/ が解決できないため）。
      const htmlUrl = new URL(c.req.url);
      htmlUrl.searchParams.set('format', 'html');
      const api = `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/browser-rendering/pdf`;
      const resp = await fetch(api, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${c.env.CF_BROWSER_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: htmlUrl.toString(),
          gotoOptions: { waitUntil: 'networkidle0' },
        }),
      });
      const ct = resp.headers.get('content-type') || '';
      if (resp.ok && ct.includes('application/pdf')) {
        const label = doc.type === 'receipt' ? '領収書' : '請求書';
        const fname = encodeURIComponent(`${label}_${data.documentNumber}.pdf`);
        return new Response(resp.body, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename*=UTF-8''${fname}`,
            'Cache-Control': 'no-store',
          },
        });
      }
      // 失敗時は下のHTML表示にフォールバック（画面から印刷でも保存できる）
    } catch {
      // ネットワーク等の失敗時もHTML表示にフォールバック
    }
  }

  // メール送信ボタンは Resend 設定時のみ表示。既定の宛先は顧客の登録メール。
  const emailEnabled = !!(c.env.RESEND_API_KEY && c.env.MAIL_FROM);
  const defaultEmail = (customer as { email?: string } | null)?.email || '';

  return c.html(
    renderDocumentHtml({
      ...data,
      pdfHref: pdfEnabled ? '?format=pdf' : undefined,
      mailApiPath: emailEnabled ? `/api/documents/${token}/email` : undefined,
      defaultEmail: emailEnabled ? defaultEmail : undefined,
    }),
  );
});

/**
 * POST /api/documents/:token/email  領収書/請求書をメールで送信（閲覧リンク付き）
 * 既定の宛先は顧客の登録メール。body.email があればそちらへ送る（任意変更）。
 */
app.post('/:token/email', async (c) => {
  const token = c.req.param('token');
  const doc = await getDocumentByToken(c.env.DB, token);
  if (!doc) return c.json({ error: '書類が見つかりませんでした' }, 404);
  if (!c.env.RESEND_API_KEY || !c.env.MAIL_FROM) {
    return c.json({ error: 'メール送信が未設定のため送信できません' }, 400);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    /* 空ボディ可（既定宛先へ送信） */
  }

  const customer = await getCustomerProfile(c.env.DB, doc.customer_id);
  const cust = customer as { email?: string; company_name?: string; contact_name?: string } | null;
  const invoiceName = await c.env.DB.prepare('SELECT invoice_name FROM booking_groups WHERE id = ?')
    .bind(doc.group_id)
    .first<{ invoice_name: string | null }>();
  const recipientName =
    (invoiceName?.invoice_name || '').trim() ||
    (cust?.contact_name || '').trim() ||
    (cust?.company_name || '').trim() ||
    'お客様';

  const requested = String((body.email as string) || '').trim();
  const target = requested || (cust?.email || '').trim();
  if (!target) return c.json({ error: '送信先メールアドレスがありません' }, 400);
  if (!isValidEmail(target)) return c.json({ error: 'メールアドレスの形式が正しくありません' }, 400);

  const mail = documentEmail({
    type: doc.type,
    documentNumber: doc.booking_number + (doc.type === 'receipt' ? '-RCP' : '-INV'),
    bookingNumber: doc.booking_number,
    recipientName,
    total: doc.total_amount,
    url: documentUrl(c, token),
  });
  const res = await sendEmail(c.env, { to: target, subject: mail.subject, html: mail.html, text: mail.text });
  if (!res.ok) return c.json({ error: res.error || '送信に失敗しました' }, 502);
  return c.json({ ok: true, sentTo: target });
});

export default app;
