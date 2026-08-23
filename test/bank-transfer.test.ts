import { describe, it, expect } from 'vitest';
import { parseJpBankTransfer } from '../src/lib/stripe';

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
