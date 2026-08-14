/**
 * 割引・チケット・ポイント・キャンペーン・オプションの適用ロジック
 *
 * 確定した併用ルール（v2.1 追補 2.5）:
 *  - 割引の主役は クーポン / チケット / ポイント / なし のいずれか1つ
 *  - スペース料金（＋残置料金）のみが割引対象。オプションは常に割引対象外
 *  - キャンペーン: なし→フル / クーポン→不可 / チケット→超過分のみ / ポイント→不可
 *  - チケット/クーポンの充当は「高い時間帯から先に」（お客様に有利）
 */

export type DiscountType = 'percent' | 'fixed';

/** 割引対象の1日（スペース料金）。price は季節料金込みの最終スペース料金。 */
export interface DiscountableDay {
  billableHours: number;
  price: number;
}

/** キャンペーン割引ルール */
export interface CampaignRule {
  discountType: DiscountType;
  discountValue: number;
}

/** 適用判定用のキャンペーン候補（DBの campaigns 行に対応） */
export interface CampaignCandidate {
  name: string;
  startDate: string;
  endDate: string;
  discountType: DiscountType;
  discountValue: number;
  applyWeekday: boolean;
  applyWeekend: boolean;
  spaceId: string | null; // null = 全スペース対象
}

/** 割引対象日（キャンペーン適用判定用） */
export interface CampaignDay {
  date: string;
  dayType: 'weekday' | 'weekend';
  price: number;
  seasonalPct?: number; // >0 の日は季節料金（割増）期間。キャンペーンは適用不可（季節料金優先）
}

/**
 * 予約に適用できるキャンペーンを1つ解決する。
 * - 予約の全日程が「期間内」かつ「曜日区分が対象」かつ「対象スペース」であること。
 *   （複数日で一部でも対象外があれば、そのキャンペーンは不適用）
 * - 季節料金（割増）期間に該当する日が1日でもあれば、キャンペーンは適用しない（季節料金優先）。
 * - 対象が複数ある場合はスペース料金に対する割引額が最大のものを選ぶ。
 */
export function resolveCampaign(
  campaigns: readonly CampaignCandidate[],
  days: readonly CampaignDay[],
  spaceId: string,
): { rule: CampaignRule; name: string } | null {
  const spaceFee = days.reduce((s, d) => s + d.price, 0);
  if (spaceFee <= 0 || days.length === 0) return null;
  // 季節料金（割増）が1日でも掛かっていればキャンペーンは不適用（季節料金優先）
  if (days.some((d) => (d.seasonalPct ?? 0) > 0)) return null;
  let best: { rule: CampaignRule; name: string; discount: number } | null = null;
  for (const cp of campaigns) {
    if (cp.spaceId && cp.spaceId !== spaceId) continue;
    const allEligible = days.every(
      (d) =>
        d.date >= cp.startDate &&
        d.date <= cp.endDate &&
        (d.dayType === 'weekday' ? cp.applyWeekday : cp.applyWeekend),
    );
    if (!allEligible) continue;
    const discount =
      cp.discountType === 'percent'
        ? Math.round((spaceFee * cp.discountValue) / 100)
        : Math.min(cp.discountValue, spaceFee);
    if (discount <= 0) continue;
    if (!best || discount > best.discount) {
      best = {
        rule: { discountType: cp.discountType, discountValue: cp.discountValue },
        name: cp.name,
        discount,
      };
    }
  }
  return best ? { rule: best.rule, name: best.name } : null;
}

/** 主となる割引の指定 */
export type PrimaryDiscount =
  | { kind: 'none' }
  | {
      kind: 'coupon';
      discountType: DiscountType;
      discountValue: number;
      remainingHours: number;
    }
  | { kind: 'ticket'; remainingHours: number }
  | { kind: 'points'; pointsToUse: number; pointBalance: number };

export interface DiscountInput {
  /** スペース料金の日別内訳（残置日含む） */
  days: readonly DiscountableDay[];
  /** 主となる割引 */
  primary: PrimaryDiscount;
  /** キャンペーン（該当中のもの。併用可否はルールに従い内部判定） */
  campaign?: CampaignRule;
  /** オプション料金合計（割引対象外） */
  optionsTotal?: number;
  /** ポイント付与率（%）。デフォルト1 */
  pointRate?: number;
}

export interface DiscountResult {
  spaceFee: number; // 割引前スペース料金合計
  primaryKind: PrimaryDiscount['kind'];
  primaryDiscount: number; // クーポン/チケット/ポイントによる値引き額
  couponHoursConsumed: number;
  ticketHoursConsumed: number;
  pointsUsed: number;
  campaignDiscount: number;
  optionsTotal: number;
  total: number; // 最終請求額
  pointsEarned: number; // 完了時に付与される見込みポイント
}

/** 単価（円/時）の高い日から順にソートしたコピーを返す */
function sortByUnitPriceDesc(days: readonly DiscountableDay[]): DiscountableDay[] {
  return [...days].sort((a, b) => b.price / b.billableHours - a.price / a.billableHours);
}

/**
 * 高い時間帯から hours 時間分を充当したときの「充当対象の金額（円）」を返す。
 * 日単位で切り出し、端数は日ごとに丸める。
 */
function coveredAmountForHours(days: readonly DiscountableDay[], hours: number): {
  coveredYen: number;
  coveredHours: number;
} {
  let remaining = Math.max(0, Math.floor(hours));
  let coveredYen = 0;
  let coveredHours = 0;
  for (const d of sortByUnitPriceDesc(days)) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, d.billableHours);
    coveredYen += Math.round((take * d.price) / d.billableHours);
    coveredHours += take;
    remaining -= take;
  }
  return { coveredYen, coveredHours };
}

/** キャンペーン割引額を計算（base に対して） */
function campaignDiscountFor(base: number, campaign?: CampaignRule): number {
  if (!campaign || base <= 0) return 0;
  if (campaign.discountType === 'percent') {
    return Math.round((base * campaign.discountValue) / 100);
  }
  // fixed: base を上限に控除
  return Math.min(campaign.discountValue, base);
}

/**
 * 割引・キャンペーン・ポイント・オプションを適用して最終金額を算出する。
 */
export function applyDiscounts(input: DiscountInput): DiscountResult {
  const days = input.days;
  const spaceFee = days.reduce((s, d) => s + d.price, 0);
  const optionsTotal = input.optionsTotal ?? 0;
  const pointRate = input.pointRate ?? 1;

  let primaryDiscount = 0;
  let campaignDiscount = 0;
  let couponHoursConsumed = 0;
  let ticketHoursConsumed = 0;
  let pointsUsed = 0;

  switch (input.primary.kind) {
    case 'none': {
      // キャンペーンはフル適用
      campaignDiscount = campaignDiscountFor(spaceFee, input.campaign);
      break;
    }
    case 'coupon': {
      const p = input.primary;
      const { coveredYen, coveredHours } = coveredAmountForHours(days, p.remainingHours);
      couponHoursConsumed = coveredHours;
      if (p.discountType === 'percent') {
        primaryDiscount = Math.round((coveredYen * p.discountValue) / 100);
      } else {
        primaryDiscount = Math.min(p.discountValue, coveredYen);
      }
      // クーポン利用時はキャンペーン不可（超過分も満額）
      campaignDiscount = 0;
      break;
    }
    case 'ticket': {
      const p = input.primary;
      const { coveredYen, coveredHours } = coveredAmountForHours(days, p.remainingHours);
      ticketHoursConsumed = coveredHours;
      // 残時間内は¥0
      primaryDiscount = coveredYen;
      // 超過分（未充当のスペース料金）にキャンペーン適用可
      const overflowYen = spaceFee - coveredYen;
      campaignDiscount = campaignDiscountFor(overflowYen, input.campaign);
      break;
    }
    case 'points': {
      const p = input.primary;
      // ポイント使用時はキャンペーン対象外
      const usable = Math.max(0, Math.min(p.pointsToUse, p.pointBalance, spaceFee));
      pointsUsed = usable;
      primaryDiscount = usable;
      campaignDiscount = 0;
      break;
    }
  }

  // 最終スペース料金（0未満にはしない）
  const discountedSpace = Math.max(0, spaceFee - primaryDiscount - campaignDiscount);
  const total = discountedSpace + optionsTotal;

  // 付与ポイント（最終支払い金額の pointRate%、1円未満切り捨て）
  const pointsEarned = Math.floor((total * pointRate) / 100);

  return {
    spaceFee,
    primaryKind: input.primary.kind,
    primaryDiscount,
    couponHoursConsumed,
    ticketHoursConsumed,
    pointsUsed,
    campaignDiscount,
    optionsTotal,
    total,
    pointsEarned,
  } satisfies DiscountResult;
}

/** 季節料金（割増）期間（重複チェック用） */
export interface SeasonalPeriod {
  name: string;
  startDate: string;
  endDate: string;
  spaceIds: readonly string[]; // 空配列 = 全スペース対象
  isActive: boolean;
}

/**
 * キャンペーン（割引）が、有効な季節料金（割増）期間と重複するかを判定する。
 * 季節料金が優先のため、重複するキャンペーンは登録させない（管理画面バリデーション用）。
 * - 期間が重なる かつ 対象スペースが重なる（どちらかが全スペース対象なら重なるとみなす）
 * - 有効(isActive)な季節料金のみ対象
 * 返り値: 最初に見つかった衝突する季節料金（無ければ null）
 */
export function seasonalCampaignConflict(
  seasonals: readonly SeasonalPeriod[],
  campaign: { startDate: string; endDate: string; spaceId: string | null },
): SeasonalPeriod | null {
  for (const s of seasonals) {
    if (!s.isActive) continue;
    const dateOverlap = campaign.startDate <= s.endDate && s.startDate <= campaign.endDate;
    if (!dateOverlap) continue;
    const spaceOverlap =
      campaign.spaceId === null || s.spaceIds.length === 0 || s.spaceIds.includes(campaign.spaceId);
    if (spaceOverlap) return s;
  }
  return null;
}
