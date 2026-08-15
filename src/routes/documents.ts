import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  getDocumentByToken,
  getBookingSummaryForGroup,
  getCustomerProfile,
  getIssuerInfo,
} from '../db/repository';
import { renderDocumentHtml, type DocumentData } from '../lib/documents';

const app = new Hono<AppBindings>();

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
  return c.html(renderDocumentHtml(data));
});

export default app;
