import { describe, it, expect } from 'vitest';
import { optionSubtotal, normalizeQuantity, hasStock, type OptionSpec } from '../src/lib/options';

describe('optionSubtotal', () => {
  it('free → 0', () => {
    expect(optionSubtotal('free', 0, 5)).toBe(0);
  });
  it('fixed → 数量に依らず固定', () => {
    expect(optionSubtotal('fixed', 5500, 3)).toBe(5500);
  });
  it('per_unit → 単価×数量', () => {
    expect(optionSubtotal('per_unit', 1100, 3)).toBe(3300); // ゴミ袋3袋
    expect(optionSubtotal('per_unit', 550, 4)).toBe(2200); // ハンガーラック4台
  });
});

describe('normalizeQuantity', () => {
  const toggle: OptionSpec = { id: 't', type: 'toggle', priceType: 'fixed', unitPrice: 3300, maxQty: null, stockTotal: 1 };
  const qty: OptionSpec = { id: 'q', type: 'quantity', priceType: 'per_unit', unitPrice: 1100, maxQty: null, stockTotal: 10 };

  it('toggle は常に1', () => {
    expect(normalizeQuantity(toggle, 5).quantity).toBe(1);
  });
  it('quantity: 正常', () => {
    expect(normalizeQuantity(qty, 3)).toEqual({ quantity: 3 });
  });
  it('quantity: 0以下はエラー', () => {
    expect(normalizeQuantity(qty, 0).error).toBeTruthy();
  });
  it('quantity: 在庫超過はエラー', () => {
    expect(normalizeQuantity(qty, 11).error).toBeTruthy();
  });
});

describe('hasStock', () => {
  it('在庫内はtrue、超過はfalse', () => {
    expect(hasStock(10, 7, 3)).toBe(true);
    expect(hasStock(10, 8, 3)).toBe(false);
  });
  it('無制限(null)は常にtrue', () => {
    expect(hasStock(null, 999, 999)).toBe(true);
  });
});
