import { describe, it, expect } from 'vitest';
import { parseJpBankTransfer } from '../src/lib/stripe';
import { bankTransferInfoEmail } from '../src/lib/email';

describe('parseJpBankTransfer', () => {
  it('financial_addresses から日本の振込先を取り出す', () => {
    const info = parseJpBankTransfer({
      bank_transfer: {
        financial_addresses: [
          {
            jp_bank_transfer: {
              bank_name: 'テスト銀行',
              branch_name: '名駅支店',
              account_type: 'futsu',
              account_number: '1234567',
              account_holder_name: 'カ）ファーストクリエイト',
            },
          },
        ],
      },
    });
    expect(info).not.toBeNull();
    expect(info!.bankName).toBe('テスト銀行');
    expect(info!.branchName).toBe('名駅支店');
    expect(info!.accountType).toBe('普通'); // futsu → 普通
    expect(info!.accountNumber).toBe('1234567');
    expect(info!.accountHolderName).toBe('カ）ファーストクリエイト');
  });

  it('口座番号が無ければ null', () => {
    expect(parseJpBankTransfer({ bank_transfer: { financial_addresses: [] } })).toBeNull();
    expect(parseJpBankTransfer({})).toBeNull();
  });

  it('当座は「当座」に変換', () => {
    const info = parseJpBankTransfer({
      bank_transfer: { financial_addresses: [{ jp_bank_transfer: { account_type: 'toza', account_number: '9' } }] },
    });
    expect(info!.accountType).toBe('当座');
  });
});

describe('bankTransferInfoEmail', () => {
  it('口座情報・金額・予約番号を含む', () => {
    const m = bankTransferInfoEmail({
      customerName: '山田 太郎',
      bookingNumber: 'ALBE-20260917-0001',
      spaceName: 'アルベホール名古屋',
      amount: 10890,
      bank: { bankName: 'テスト銀行', branchName: '名駅支店', accountType: '普通', accountNumber: '1234567', accountHolderName: 'カ）ファーストクリエイト' },
      mypageUrl: 'https://booking.space-albe.com/mypage.html',
    });
    expect(m.subject).toContain('お振込先');
    expect(m.text).toContain('テスト銀行');
    expect(m.text).toContain('1234567');
    expect(m.text).toContain('¥10,890');
    expect(m.html).toContain('口座番号');
    expect(m.html).toContain('マイページで振込先を確認する');
  });
  it('入金までは未確定・仮押さえ・自動キャンセルの旨を明記（#39）', () => {
    const m = bankTransferInfoEmail({
      customerName: '山田 太郎',
      bookingNumber: 'B1',
      spaceName: 'S',
      amount: 10890,
      bank: { bankName: 'テスト銀行', branchName: '名駅支店', accountType: '普通', accountNumber: '1234567', accountHolderName: 'カ）ファーストクリエイト' },
    });
    expect(m.text).toContain('お支払い待ち');
    expect(m.text).toContain('確定していません');
    expect(m.text).toContain('自動的にキャンセル');
    expect(m.html).toContain('お支払い待ち');
  });
  it('口座情報が取れないときも案内メールを生成（お支払い画面URLへ誘導）', () => {
    const m = bankTransferInfoEmail({
      customerName: '山田 太郎',
      bookingNumber: 'B2',
      spaceName: 'S',
      amount: 4840,
      bank: null,
      paymentUrl: 'https://checkout.stripe.com/pay/cs_test_123',
      mypageUrl: 'https://booking.space-albe.com/mypage.html',
    });
    expect(m.subject).toContain('お振込先');
    expect(m.text).toContain('¥4,840');
    expect(m.text).toContain('お支払い案内ページ');
    expect(m.text).toContain('https://checkout.stripe.com/pay/cs_test_123');
    expect(m.html).toContain('お支払い案内ページを開く');
  });
});
