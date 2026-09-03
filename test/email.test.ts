import { describe, it, expect } from 'vitest';
import {
  sendEmail,
  escapeHtml,
  bookingConfirmationEmail,
  cancellationEmail,
  refundEmail,
  adminNewBookingEmail,
  rescheduleEmail,
  adminRescheduleEmail,
  adminPaymentActionAlertEmail,
  paymentMethodStatusLabel,
  bookingFailedEmail,
  adminBookingFailedEmail,
  paymentPendingBookingEmail,
  adminLatePaymentOnReleasedEmail,
  contactReceivedEmail,
  adminContactEmail,
  ticketExpiryNoticeEmail,
  additionalPaidConfirmedEmail,
  adminAdditionalPaidEmail,
  refundAccountRequestEmail,
  paymentConfirmedEmail,
  paymentMethodJp,
} from '../src/lib/email';

const sampleDays = [{ date: '2026-09-10', startTime: '10:00', endTime: '13:00' }];

describe('email - sendEmail の有効化条件', () => {
  it('APIキー未設定なら送信せず skipped', async () => {
    const r = await sendEmail({ MAIL_FROM: 'a@b.jp' }, { to: 'x@y.jp', subject: 's', html: 'h', text: 't' });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
  });
  it('MAIL_FROM 未設定なら送信せず skipped', async () => {
    const r = await sendEmail({ RESEND_API_KEY: 'k' }, { to: 'x@y.jp', subject: 's', html: 'h', text: 't' });
    expect(r.skipped).toBe(true);
  });
  it('ステージングでは鍵が揃っていても実送信しない（安全装置）', async () => {
    const r = await sendEmail(
      { APP_ENV: 'staging', RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.jp' },
      { to: 'x@y.jp', subject: 's', html: 'h', text: 't' },
    );
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
  });
  it('ステージングでも STAGING_ALLOW_EMAIL=true ならガードを通過する（staging即skipにならない）', async () => {
    // ネットワークを叩かないよう宛先を空にする。staging ガードを通過すると宛先チェックまで進み、
    // 「no recipient」で返る＝「staging即skip」ではないことを確認できる。
    const r = await sendEmail(
      { APP_ENV: 'staging', STAGING_ALLOW_EMAIL: 'true', RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.jp' },
      { to: '', subject: 's', html: 'h', text: 't' },
    );
    expect(r.skipped).toBeUndefined();
    expect(r.error).toBe('no recipient');
  });
});

describe('email - escapeHtml', () => {
  it('特殊文字をエスケープ', () => {
    expect(escapeHtml('<b>"A&B"</b>')).toBe('&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;');
  });
});

describe('email - 予約確認テンプレート', () => {
  it('本予約: 予約番号・金額・日時を含む', () => {
    const m = bookingConfirmationEmail({
      bookingNumber: '20260910-001',
      spaceName: 'アルベホール名古屋',
      eventName: 'セミナー',
      customerName: '山田太郎',
      days: sampleDays,
      total: 28314,
      status: 'confirmed',
    });
    expect(m.subject).toContain('20260910-001');
    expect(m.subject).toContain('ご予約');
    expect(m.text).toContain('¥28,314');
    expect(m.text).toContain('2026-09-10');
    expect(m.html).toContain('アルベホール名古屋');
  });
  it('HTMLは可変値をエスケープする', () => {
    const m = bookingConfirmationEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: '<script>x</script>', customerName: 'A&B',
      days: sampleDays, total: 1000, status: 'confirmed',
    });
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('A&amp;B');
    expect(m.html).not.toContain('<script>x</script>');
  });
  it('仮予約は件名が仮予約表記', () => {
    const m = bookingConfirmationEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      days: sampleDays, total: 1000, status: 'tentative',
    });
    expect(m.subject).toContain('仮予約');
  });
  it('スペース案内文（spaceNote）: 本予約では差し込む・改行保持・エスケープ', () => {
    const note = '【解錠方法】\nスマートキー番号：48240319\n<b>タグ</b>';
    const m = bookingConfirmationEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      days: sampleDays, total: 1000, status: 'confirmed', spaceNote: note,
    });
    expect(m.text).toContain('ご利用スペースからのご案内');
    expect(m.text).toContain('48240319');
    expect(m.text).toContain('【解錠方法】');
    expect(m.html).toContain('ご利用スペースからのご案内');
    expect(m.html).toContain('48240319');
    expect(m.html).toContain('&lt;b&gt;'); // エスケープ済み
    expect(m.html).not.toContain('<b>タグ</b>');
  });
  it('スペース案内文（spaceNote）: 商談中（tentative）には出さない', () => {
    const m = bookingConfirmationEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      days: sampleDays, total: 1000, status: 'tentative', spaceNote: 'スマートキー番号：48240319',
    });
    expect(m.text).not.toContain('48240319');
    expect(m.text).not.toContain('ご利用スペースからのご案内');
  });
  it('スペース案内文（spaceNote）: 空欄なら差し込まない', () => {
    const m = bookingConfirmationEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      days: sampleDays, total: 1000, status: 'confirmed', spaceNote: '   ',
    });
    expect(m.text).not.toContain('ご利用スペースからのご案内');
    expect(m.html).not.toContain('ご利用スペースからのご案内');
  });
});

describe('email - キャンセル/管理者通知テンプレート', () => {
  it('キャンセル: 料金ありは金額表示', () => {
    const m = cancellationEmail({ bookingNumber: 'B1', spaceName: 'S', customerName: 'N', cancelFee: 5000 });
    expect(m.text).toContain('¥5,000');
  });
  it('キャンセル: 料金0は「発生しません」', () => {
    const m = cancellationEmail({ bookingNumber: 'B1', spaceName: 'S', customerName: 'N', cancelFee: 0 });
    expect(m.text).toContain('発生しません');
  });
  it('管理者通知: お客様の連絡先を含む', () => {
    const m = adminNewBookingEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      days: sampleDays, total: 1000, status: 'confirmed',
      customerEmail: 'c@d.jp', customerPhone: '09000000000',
    });
    expect(m.text).toContain('c@d.jp');
    expect(m.text).toContain('09000000000');
  });
});

describe('email - 日時変更（reschedule）テンプレート', () => {
  const oldDays = [{ date: '2026-09-10', startTime: '10:00', endTime: '12:00' }];
  const newDays = [{ date: '2026-09-15', startTime: '14:00', endTime: '17:00' }];
  it('本予約: 変更前後の日時と金額を含む', () => {
    const m = rescheduleEmail({
      bookingNumber: 'B1', spaceName: 'アルベホール', eventName: 'E', customerName: '山田',
      oldDays, newDays, total: 32670, status: 'confirmed', showAmount: true,
    });
    expect(m.subject).toContain('B1');
    expect(m.subject).toContain('内容を変更');
    expect(m.text).toContain('2026-09-10');
    expect(m.text).toContain('2026-09-15');
    expect(m.text).toContain('¥32,670');
  });
  it('オプションを渡すと本文に表示（管理者通知の件名は【予約内容変更】）', () => {
    const opts = [{ name: 'ハンガーラック', quantity: 2, subtotal: 1100 }];
    const cm = rescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays, total: 22880, status: 'confirmed', showAmount: true, options: opts,
    });
    expect(cm.text).toContain('ハンガーラック');
    expect(cm.text).toContain('オプション');
    const am = adminRescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays, total: 22880, status: 'confirmed', showAmount: true, options: [],
    });
    expect(am.subject).toContain('【予約内容変更】');
    expect(am.text).toContain('なし'); // 空配列は「なし」
  });
  it('商談中: 金額を表示しない（showAmount=false）', () => {
    const m = rescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays, total: 21780, status: 'tentative', showAmount: false,
    });
    expect(m.subject).toContain('仮予約');
    expect(m.text).not.toContain('¥21,780');
  });
  it('oldTotal指定・増額: 変更前後の金額と差額（追加）と変更点サマリーを表示', () => {
    const m = rescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays, total: 32670, oldTotal: 21780, status: 'confirmed', showAmount: true,
    });
    expect(m.text).toContain('変更前（税込）: ¥21,780');
    expect(m.text).toContain('変更後（税込）: ¥32,670');
    expect(m.text).toContain('差額 +¥10,890');
    expect(m.text).toContain('追加のお支払い');
    expect(m.text).toContain('変更点'); // 日時・金額のサマリー
  });
  it('お客様向け: 差額がある時のみ「担当者から別途連絡」の案内文を付す', () => {
    const withDiff = rescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays, total: 32670, oldTotal: 21780, status: 'confirmed', showAmount: true,
    });
    expect(withDiff.text).toContain('※差額については別途ご連絡差し上げますので担当者からのメールをお待ちくださいませ。');
    expect(withDiff.html).toContain('担当者からのメールをお待ちくださいませ');
    // 差額なしのときは案内文を出さない
    const noDiff = rescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays: oldDays, total: 20000, oldTotal: 20000, status: 'confirmed', showAmount: true,
    });
    expect(noDiff.text).not.toContain('担当者からのメールをお待ち');
  });
  it('管理者向けメールには「担当者から別途連絡」の案内文を付さない', () => {
    const am = adminRescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays, total: 32670, oldTotal: 21780, status: 'confirmed', showAmount: true,
    });
    expect(am.text).not.toContain('担当者からのメールをお待ち');
  });
  it('oldTotal指定・減額: 返金の差額を表示', () => {
    const m = rescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays, total: 10000, oldTotal: 15000, status: 'confirmed', showAmount: true,
    });
    expect(m.text).toContain('差額 -¥5,000');
    expect(m.text).toContain('ご返金');
  });
  it('oldTotal同額: 差額ブロックを出さず単一金額のみ表示', () => {
    const m = rescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays: oldDays, total: 20000, oldTotal: 20000, status: 'confirmed', showAmount: true,
    });
    expect(m.text).toContain('変更後の合計金額（税込）: ¥20,000');
    expect(m.text).not.toContain('差額');
  });
  it('オプション欄を渡しても optionsChanged=false なら「変更点: オプション」を出さない', () => {
    const m = rescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays, total: 1200, oldTotal: 1200, status: 'confirmed', showAmount: true,
      options: [], optionsChanged: false,
    });
    expect(m.html).not.toContain('変更点: オプション');
    expect(m.text).not.toContain('【変更点】オプション');
  });
  it('optionsChanged=true のときだけ「変更点」にオプションを出す', () => {
    const m = rescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays, total: 1200, oldTotal: 1200, status: 'confirmed', showAmount: true,
      options: [{ name: '椅子', quantity: 2, subtotal: 200 }], optionsChanged: true,
    });
    expect(m.html).toContain('オプション');
    expect(m.text).toContain('オプション');
  });
  it('管理者通知: 連絡先と変更前後を含む', () => {
    const m = adminRescheduleEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      oldDays, newDays, total: 1000, status: 'confirmed', showAmount: true,
      customerEmail: 'c@d.jp', customerPhone: '09000000000',
    });
    expect(m.text).toContain('c@d.jp');
    expect(m.text).toContain('2026-09-10');
    expect(m.text).toContain('2026-09-15');
  });
});

describe('email - 返金/追加請求 管理者アラート（#62/#63/#64）', () => {
  it('支払い方法＋入金状況ラベル（振込・未入金/入金済み）', () => {
    expect(paymentMethodStatusLabel('bank_transfer', 'unpaid')).toBe('銀行振込（Stripe収納代行）（未入金）');
    expect(paymentMethodStatusLabel('bank_transfer', 'paid')).toBe('銀行振込（Stripe収納代行）（入金済み）');
    expect(paymentMethodStatusLabel('stripe', 'paid')).toContain('Stripe');
    expect(paymentMethodStatusLabel(null)).toBe('不明');
  });
  it('予約変更・追加請求: 金額・支払い方法・内訳を明記', () => {
    const m = adminPaymentActionAlertEmail({
      kind: 'reschedule', action: 'surcharge', amount: 4840,
      bookingNumber: 'B9', spaceName: '名駅フリースペース', customerName: '山田',
      paymentMethod: 'bank_transfer', paymentStatus: 'unpaid', oldTotal: 10000, newTotal: 14840,
    });
    expect(m.subject).toContain('追加請求');
    expect(m.subject).toContain('¥4,840');
    expect(m.text).toContain('銀行振込（Stripe収納代行）（未入金）');
    expect(m.text).toContain('変更前の合計（税込）: ¥10,000');
    expect(m.text).toContain('変更後の合計（税込）: ¥14,840');
    expect(m.text).toContain('追加のお支払い');
  });
  it('キャンセル・返金: 既収金額とキャンセル料と返金額を明記', () => {
    const m = adminPaymentActionAlertEmail({
      kind: 'cancel', action: 'refund', amount: 2000,
      bookingNumber: 'B8', spaceName: 'S', customerName: '佐藤',
      paymentMethod: 'stripe', paymentStatus: 'paid', cancelFee: 8000, paidAmount: 10000,
    });
    expect(m.subject).toContain('返金');
    expect(m.subject).toContain('¥2,000');
    expect(m.text).toContain('既収金額（税込）: ¥10,000');
    expect(m.text).toContain('キャンセル料（税込）: ¥8,000');
    expect(m.text).toContain('返金が必要です');
  });
});

describe('email - 決済先行 不成立・返金（#68）', () => {
  it('お客様向け（カード）: 満室で不成立・全額返金の旨を明記', () => {
    const m = bookingFailedEmail({
      customerName: '山田',
      bookingNumber: 'B10',
      spaceName: '名駅フリースペース',
      days: sampleDays,
      total: 4840,
      paymentMethod: 'stripe',
    });
    expect(m.subject).toContain('成立しませんでした');
    expect(m.text).toContain('成立いたしませんでした');
    expect(m.text).toContain('全額ご返金いたします');
    expect(m.text).toContain('¥4,840');
  });
  it('お客様向け（PayPal）: 未確定のため請求なしの旨', () => {
    const m = bookingFailedEmail({
      customerName: '山田',
      bookingNumber: 'B10',
      spaceName: 'S',
      days: sampleDays,
      total: 4840,
      paymentMethod: 'paypal',
    });
    expect(m.text).toContain('ご請求は発生いたしません');
  });
  it('管理者向け（カード・自動返金成功）: 自動返金実行を明記', () => {
    const m = adminBookingFailedEmail({
      bookingNumber: 'B10',
      spaceName: 'S',
      days: sampleDays,
      total: 4840,
      paymentMethod: 'stripe',
      customerName: '山田',
      customerEmail: 'y@z.jp',
      refundOk: true,
    });
    expect(m.subject).toContain('予約不成立');
    expect(m.text).toContain('自動返金を実行しました');
    expect(m.text).toContain('y@z.jp');
  });
  it('管理者向け（カード・自動返金失敗）: 手動返金を促す', () => {
    const m = adminBookingFailedEmail({
      bookingNumber: 'B10',
      spaceName: 'S',
      days: sampleDays,
      total: 4840,
      paymentMethod: 'stripe',
      customerName: '山田',
      refundOk: false,
    });
    expect(m.text).toContain('手動で返金');
  });
  it('管理者向け（PayPal）: 未キャプチャで対応不要', () => {
    const m = adminBookingFailedEmail({
      bookingNumber: 'B10',
      spaceName: 'S',
      days: sampleDays,
      total: 4840,
      paymentMethod: 'paypal',
      customerName: '山田',
      refundOk: false,
    });
    expect(m.text).toContain('対応不要');
  });
});

describe('email - お支払い待ち予約受付（銀行振込・コンビニ共通・#39）', () => {
  it('予約明細・支払い方法・「Stripeのメール確認」「期限内未入金は自動キャンセル」を含む', () => {
    const m = paymentPendingBookingEmail({
      customerName: '山田太郎',
      bookingNumber: '20260826-001',
      spaceName: '名駅フリースペース',
      eventName: '会議',
      days: sampleDays,
      total: 4840,
      paymentMethodLabel: 'コンビニ払い',
      mypageUrl: 'https://booking.space-albe.com/mypage.html',
    });
    expect(m.subject).toContain('20260826-001');
    expect(m.subject).toContain('お支払い待ち');
    expect(m.text).toContain('お支払い待ち');
    expect(m.text).toContain('¥4,840');
    expect(m.text).toContain('2026-09-10'); // 予約日時（明細）
    expect(m.text).toContain('コンビニ払い');
    expect(m.text).toContain('Stripe'); // 振込先・払込番号はStripeのメールを確認
    expect(m.text).toContain('自動的にキャンセル');
    expect(m.html).toContain('Stripe（決済代行）から届くメール');
  });
  it('銀行振込でも同じ骨子。可変値はエスケープする', () => {
    const m = paymentPendingBookingEmail({
      customerName: 'A&B',
      bookingNumber: 'B1',
      spaceName: '<script>x</script>',
      days: sampleDays,
      total: 1000,
      paymentMethodLabel: '銀行振込',
    });
    expect(m.text).toContain('銀行振込');
    expect(m.html).toContain('A&amp;B');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).not.toContain('<script>x</script>');
  });
  it('請求書払い（viaStripe:false）はStripeではなく当社発行の請求書を案内する', () => {
    const m = paymentPendingBookingEmail({
      customerName: '山田太郎',
      bookingNumber: '20260826-003',
      spaceName: '名駅フリースペース',
      days: sampleDays,
      total: 4840,
      paymentMethodLabel: '請求書払い',
      viaStripe: false,
      mypageUrl: 'https://booking.space-albe.com/mypage.html',
    });
    expect(m.text).toContain('請求書払い');
    expect(m.text).toContain('請求書'); // 振込先は当社発行の請求書に記載
    expect(m.text).not.toContain('Stripe'); // 請求書払いはStripe非経由
    expect(m.text).toContain('自動的にキャンセル'); // 期限内未入金は自動キャンセル
    expect(m.html).not.toContain('Stripe');
    expect(m.html).toContain('請求書');
  });
});

describe('email - 解放後の着金 管理者アラート（#39）', () => {
  it('要対応・予約番号・お客様連絡先を含む', () => {
    const m = adminLatePaymentOnReleasedEmail({
      bookingNumber: '20260826-002',
      spaceName: '名駅フリースペース',
      customerName: '山田太郎',
      customerEmail: 'y@z.jp',
    });
    expect(m.subject).toContain('要対応');
    expect(m.subject).toContain('20260826-002');
    expect(m.text).toContain('自動での予約確定は行っていません');
    expect(m.text).toContain('y@z.jp');
    expect(m.html).toContain('返金または');
  });
});

describe('email - お問い合わせ（公式サイト /contact/）テンプレート', () => {
  const base = {
    type: 'quote',
    spaceName: '栄チャペル',
    date: '2026-12-24',
    days: '2',
    name: '山田 太郎',
    company: '株式会社○○',
    mail: 'taro@example.com',
    tel: '0521234567',
    body: '12月に30名で利用したいです。',
    page: 'https://space-albe.com',
  } as const;

  it('お客様控え（日本語）：用件ラベル・内容・件名', () => {
    const m = contactReceivedEmail({ ...base, lang: 'ja' });
    expect(m.subject).toContain('お問い合わせを受け付けました');
    expect(m.html).toContain('お見積り'); // type=quote の日本語ラベル
    expect(m.html).toContain('山田 太郎');
    expect(m.text).toContain('12月に30名で利用したいです。');
  });

  it('お客様控え（英語）：lang=en なら英語で送る', () => {
    const m = contactReceivedEmail({ ...base, lang: 'en' });
    expect(m.subject).toContain('received your inquiry');
    expect(m.html).toContain('Quote / Estimate');
    expect(m.text).toContain('Dear 山田 太郎');
  });

  it('担当者宛：件名に用件と氏名・本文にメールが入る', () => {
    const m = adminContactEmail({ ...base, lang: 'ja', adminUrl: 'https://booking.space-albe.com/admin.html' });
    expect(m.subject).toContain('【お問い合わせ】');
    expect(m.subject).toContain('山田 太郎');
    expect(m.html).toContain('taro@example.com');
    expect(m.html).toContain('管理画面を開く');
  });

  it('未知の用件は「その他」に丸める', () => {
    const m = contactReceivedEmail({ ...base, type: 'unknown-xyz', lang: 'ja' });
    expect(m.html).toContain('その他');
  });
});

describe('email - refundEmail（返金完了のお知らせ）', () => {
  const base = { bookingNumber: '20260910-001', spaceName: '名駅フリースペース', customerName: '山田太郎', amount: 3300 };
  it('件名・予約番号・返金額を含む', () => {
    const m = refundEmail({ ...base, method: 'card' });
    expect(m.subject).toContain('ご返金のお知らせ');
    expect(m.subject).toContain('20260910-001');
    expect(m.text).toContain('¥3,300');
    expect(m.html).toContain('¥3,300');
  });
  it('カードはカード明細への反映案内を含む', () => {
    const m = refundEmail({ ...base, method: 'card' });
    expect(m.text).toContain('クレジットカード');
    expect(m.text).toContain('明細');
  });
  it('PayPalはPayPalの案内を含む', () => {
    const m = refundEmail({ ...base, method: 'paypal' });
    expect(m.text).toContain('PayPal');
  });
  it('銀行振込は振込返金の案内を含む', () => {
    const m = refundEmail({ ...base, method: 'bank' });
    expect(m.text).toContain('銀行振込');
    expect(m.text).toContain('口座');
  });
});

describe('email - ticketExpiryNoticeEmail（回数券 有効期限接近・#112）', () => {
  const base = { customerName: '山田太郎', ticketName: 'ピアノ10時間券', remainingHours: 6, validUntil: '2026-11-30' };
  it('件名に期限日・残り時間、本文に回数券名を含む', () => {
    const m = ticketExpiryNoticeEmail({ ...base, daysLabel: '約1か月' });
    expect(m.subject).toContain('2026年11月30日');
    expect(m.subject).toContain('残り6時間');
    expect(m.text).toContain('ピアノ10時間券');
    expect(m.html).toContain('ピアノ10時間券');
  });
  it('残り期間ラベルを本文に反映（2か月／1か月）', () => {
    expect(ticketExpiryNoticeEmail({ ...base, daysLabel: '約2か月' }).text).toContain('約2か月後');
    expect(ticketExpiryNoticeEmail({ ...base, daysLabel: '約1か月' }).text).toContain('約1か月後');
  });
  it('期限日を和暦表記（YYYY年M月D日）で表示', () => {
    const m = ticketExpiryNoticeEmail({ ...base, daysLabel: '約1か月' });
    expect(m.text).toContain('2026年11月30日 まで');
  });
  it('可変値（回数券名）をHTMLエスケープする', () => {
    const m = ticketExpiryNoticeEmail({ ...base, ticketName: '<b>券</b>', daysLabel: '約1か月' });
    expect(m.html).toContain('&lt;b&gt;');
    expect(m.html).not.toContain('<b>券</b>');
  });
});

describe('email - 追加請求の入金確定（顧客／管理者）', () => {
  const custBase = {
    customerName: '山内 みなみ',
    bookingNumber: '20260901-003',
    spaceName: '名駅和室スペース',
    eventName: '山内みなみヨガWS',
    days: sampleDays,
    addedAmount: 3300,
    newTotal: 12540,
  };
  it('顧客向け：件名に「確定」、本文に追加分・変更後合計を表示', () => {
    const m = additionalPaidConfirmedEmail(custBase);
    expect(m.subject).toContain('ご予約が確定');
    expect(m.subject).toContain('20260901-003');
    expect(m.text).toContain('¥3,300');
    expect(m.text).toContain('¥12,540');
    expect(m.html).toContain('¥12,540');
  });
  it('顧客向け：mypageUrl があれば領収書導線、spaceNote を差し込む', () => {
    const m = additionalPaidConfirmedEmail({ ...custBase, mypageUrl: 'https://booking.space-albe.com/mypage.html', spaceNote: '解錠番号は 1234 です' });
    expect(m.text).toContain('https://booking.space-albe.com/mypage.html');
    expect(m.text).toContain('解錠番号は 1234 です');
    expect(m.html).toContain('解錠番号は 1234 です');
  });
  it('顧客向け：可変値をHTMLエスケープ', () => {
    const m = additionalPaidConfirmedEmail({ ...custBase, customerName: '<b>x</b>' });
    expect(m.html).toContain('&lt;b&gt;');
    expect(m.html).not.toContain('<b>x</b>');
  });
  it('管理者向け：件名に「追加入金確認」、本文に金額・お客様・管理画面リンク', () => {
    const m = adminAdditionalPaidEmail({
      bookingNumber: '20260901-003',
      spaceName: '名駅和室スペース',
      customerName: '山内 みなみ',
      customerEmail: 'pyonpyon19@example.com',
      addedAmount: 3300,
      newTotal: 12540,
      adminUrl: 'https://booking.space-albe.com/admin.html?booking=20260901-003',
    });
    expect(m.subject).toContain('追加入金確認');
    expect(m.text).toContain('¥3,300');
    expect(m.text).toContain('¥12,540');
    expect(m.text).toContain('pyonpyon19@example.com');
    expect(m.html).toContain('admin.html?booking=20260901-003');
  });
});

describe('email - 返金先口座のご連絡のお願い（顧客向け）', () => {
  const base = {
    customerName: '山内 みなみ',
    bookingNumber: '20260901-003',
    spaceName: '名駅和室スペース',
    refundAmount: 9240,
  };
  it('件名・返金額・口座の依頼文を含む（キャンセル）', () => {
    const m = refundAccountRequestEmail({ ...base, context: 'cancel' });
    expect(m.subject).toContain('ご返金先口座');
    expect(m.subject).toContain('20260901-003');
    expect(m.text).toContain('キャンセル');
    expect(m.text).toContain('¥9,240');
    expect(m.text).toContain('口座名義');
    expect(m.text).toContain('rental@space-albe.com');
  });
  it('減額（reschedule）は理由文が変わる', () => {
    const m = refundAccountRequestEmail({ ...base, context: 'reschedule' });
    expect(m.text).toContain('変更（減額）');
  });
  it('返信先（replyTo）を差し替えできる', () => {
    const m = refundAccountRequestEmail({ ...base, context: 'cancel', replyTo: 'owner@example.com' });
    expect(m.text).toContain('owner@example.com');
    expect(m.html).toContain('mailto:owner@example.com');
  });
  it('可変値をHTMLエスケープ', () => {
    const m = refundAccountRequestEmail({ ...base, customerName: '<b>x</b>', context: 'cancel' });
    expect(m.html).toContain('&lt;b&gt;');
    expect(m.html).not.toContain('<b>x</b>');
  });
});

describe('email - 管理者向け新規予約通知の入金待ち表記', () => {
  const base = {
    bookingNumber: '20260901-010', spaceName: '名駅和室スペース', eventName: 'ヨガ教室',
    customerName: '山内 みなみ', days: sampleDays, total: 9240, status: 'confirmed' as const,
    customerEmail: 'c@d.jp', customerPhone: '08000000000',
  };
  it('paymentPendingLabel なしは従来どおり（入金待ち表記なし）', () => {
    const m = adminNewBookingEmail(base);
    expect(m.subject).toContain('【新規本予約】');
    expect(m.subject).not.toContain('入金待ち');
    expect(m.text).not.toContain('入金待ち');
  });
  it('paymentPendingLabel ありは件名・本文に「入金待ち（銀行振込）」を表示', () => {
    const m = adminNewBookingEmail({ ...base, paymentPendingLabel: '銀行振込' });
    expect(m.subject).toContain('入金待ち');
    expect(m.text).toContain('入金待ち（銀行振込）');
    expect(m.html).toContain('入金待ち（銀行振込）');
  });
});

describe('email - お支払い方法の表示', () => {
  it('paymentMethodJp: 決済方法コードを日本語ラベルへ変換（未知は空文字）', () => {
    expect(paymentMethodJp('stripe')).toBe('クレジットカード');
    expect(paymentMethodJp('paypal')).toBe('PayPal');
    expect(paymentMethodJp('bank_transfer')).toBe('銀行振込');
    expect(paymentMethodJp('invoice')).toBe('請求書払い');
    expect(paymentMethodJp('konbini')).toBe('コンビニ払い');
    expect(paymentMethodJp('')).toBe('');
    expect(paymentMethodJp(null)).toBe('');
    expect(paymentMethodJp('unknown')).toBe('');
  });

  it('予約確認メール（お客様）: paymentMethodLabel を本文・HTMLに表示', () => {
    const m = bookingConfirmationEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      days: sampleDays, total: 9240, status: 'confirmed', paymentMethodLabel: 'クレジットカード',
    });
    expect(m.text).toContain('お支払い方法: クレジットカード');
    expect(m.html).toContain('お支払い方法');
    expect(m.html).toContain('クレジットカード');
  });

  it('予約確認メール（お客様）: paymentMethodLabel 未指定なら行を出さない', () => {
    const m = bookingConfirmationEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      days: sampleDays, total: 0, status: 'confirmed',
    });
    expect(m.text).not.toContain('お支払い方法');
    expect(m.html).not.toContain('お支払い方法');
  });

  it('管理者向け新規予約通知: paymentMethodLabel を本文・HTMLに表示', () => {
    const m = adminNewBookingEmail({
      bookingNumber: 'B1', spaceName: 'S', eventName: 'E', customerName: 'N',
      days: sampleDays, total: 9240, status: 'confirmed', customerEmail: 'c@d.jp',
      paymentMethodLabel: '銀行振込',
    });
    expect(m.text).toContain('支払い方法: 銀行振込');
    expect(m.html).toContain('支払い方法');
    expect(m.html).toContain('銀行振込');
  });

  it('入金確認・予約確定メール（お客様）: paymentMethodLabel を表示', () => {
    const m = paymentConfirmedEmail({
      customerName: 'N', bookingNumber: 'B1', spaceName: 'S', eventName: 'E',
      days: sampleDays, total: 9240, paymentMethodLabel: 'コンビニ払い',
    });
    expect(m.text).toContain('お支払い方法: コンビニ払い');
    expect(m.html).toContain('コンビニ払い');
  });
});
