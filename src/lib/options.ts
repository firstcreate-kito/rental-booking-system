/**
 * オプションの料金計算・数量正規化（純粋ロジック）
 */
export type OptionType = 'toggle' | 'quantity';
export type OptionPriceType = 'free' | 'fixed' | 'per_unit';

export interface OptionSpec {
  id: string;
  type: OptionType;
  priceType: OptionPriceType;
  unitPrice: number;
  maxQty: number | null;
  stockTotal: number | null;
}

/** オプションの小計を計算 */
export function optionSubtotal(
  priceType: OptionPriceType,
  unitPrice: number,
  quantity: number,
): number {
  switch (priceType) {
    case 'free':
      return 0;
    case 'fixed':
      return unitPrice; // 数量に依らず固定
    case 'per_unit':
      return unitPrice * quantity;
  }
}

export interface NormalizedQty {
  quantity: number;
  error?: string;
}

/**
 * 要求数量を正規化・検証する。
 * - toggle: 1固定
 * - quantity: 1以上、max_qty / stock_total を超えない
 */
export function normalizeQuantity(spec: OptionSpec, requested: number): NormalizedQty {
  if (spec.type === 'toggle') {
    return { quantity: 1 };
  }
  if (!Number.isInteger(requested) || requested < 1) {
    return { quantity: 0, error: '数量は1以上で指定してください' };
  }
  if (spec.maxQty != null && requested > spec.maxQty) {
    return { quantity: 0, error: `上限（${spec.maxQty}）を超えています` };
  }
  if (spec.stockTotal != null && requested > spec.stockTotal) {
    return { quantity: 0, error: `在庫（${spec.stockTotal}）を超えています` };
  }
  return { quantity: requested };
}

/** 在庫が足りるか（既存利用数 + 要求数 <= 総在庫）。stockTotal が null なら無制限 */
export function hasStock(stockTotal: number | null, used: number, requested: number): boolean {
  if (stockTotal == null) return true;
  return used + requested <= stockTotal;
}
