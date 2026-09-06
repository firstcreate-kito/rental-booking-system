/**
 * 新規会員登録特典（自動発行クーポン）の純粋ロジック。
 * DBアクセスは repository 側。ここは「ルール行→発行するクーポンの中身」への変換と
 * 対象スペースのJSONパースなど、副作用のない部分だけを扱う（テスト容易性のため）。
 */
import { addDaysJST } from './clock';

/** signup_bonus_rules の1行（DBから取得した生の形） */
export interface SignupBonusRuleRow {
  id: string;
  enabled: number; // 0/1
  name: string;
  discount_type: 'fixed' | 'percent';
  discount_value: number;
  total_hours: number;
  validity_days: number;
  space_ids: string; // JSON配列文字列
}

/** issueCoupon に渡すクーポン内容（customerId/code は呼び出し側で付与） */
export interface SignupCouponPlan {
  name: string;
  discountType: 'fixed' | 'percent';
  discountValue: number;
  totalHours: number;
  validFrom: string; // 登録日（today）
  validUntil: string; // today + validity_days（この日までに「予約」すれば利用可）
  spaceIds: string[]; // 対象スペース（空配列＝全スペース）
  source: 'signup';
}

/** space_ids（JSON文字列）を安全に配列へ。不正なら空配列。 */
export function parseSpaceIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((x) => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

/**
 * ルール行と登録日(today)から、発行するクーポンの内容を組み立てる。
 * discount_value <= 0 のルールは無効（null）。
 */
export function buildSignupCouponPlan(rule: SignupBonusRuleRow, today: string): SignupCouponPlan | null {
  if (!rule || rule.enabled !== 1) return null;
  if (rule.discount_value <= 0 || rule.total_hours <= 0) return null;
  const validityDays = rule.validity_days > 0 ? rule.validity_days : 30;
  return {
    name: rule.name,
    discountType: rule.discount_type === 'percent' ? 'percent' : 'fixed',
    discountValue: rule.discount_value,
    totalHours: rule.total_hours,
    validFrom: today,
    validUntil: addDaysJST(today, validityDays),
    spaceIds: parseSpaceIds(rule.space_ids),
    source: 'signup',
  };
}
