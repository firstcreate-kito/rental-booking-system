/**
 * チケット予約のキャンセル・変更ポリシー（統一見解・確定版 2026-09-06）
 * docs/unified-change-cancel-policy.md §3・§4
 *
 * 純粋関数のみ（DB非依存）。daysBefore は「当初利用日までの残日数」
 *   （前日=1・当日=0・前々日=2）。呼び出し側で daysBetween(today, useDate) を渡す。
 *
 * 方針：チケット予約は現金キャンセル料は常に¥0。ペナルティはチケット時間の失効のみ。
 */

export type TicketCancelAction = 'restore' | 'forfeit';

/**
 * チケット予約キャンセル時の扱い。
 *   前々日まで（daysBefore >= 2） … 全額返還（再予約に使える）
 *   当日・前日（daysBefore <= 1） … 失効（返還なし）
 */
export function ticketCancelAction(daysBefore: number): TicketCancelAction {
  return daysBefore >= 2 ? 'restore' : 'forfeit';
}

export type TicketChangeAction =
  | 'restore_full' // 前々日以前：消費を全額チケットへ戻す（新予約で改めて消費）
  | 'move' // 当日・前日で増減なし：消費を新予約へ付け替え（返還なし）
  | 'partial_forfeit' // 当日・前日で減少：減少分を失効、残りは付け替え
  | 'blocked'; // 当日・前日で増加：チケットでの追加消費不可（新規予約で対応）

export interface TicketChangePlan {
  action: TicketChangeAction;
  /** チケットへ戻す時間 */
  restoreHours: number;
  /** 失効する時間 */
  forfeitHours: number;
  /** blocked のときの案内文言 */
  message?: string;
}

/**
 * チケット予約の日時変更時の扱い。
 * @param daysBefore 当初利用日までの残日数（前日=1・当日=0・前々日=2）
 * @param oldHours 元の予約の消費チケット時間
 * @param newHours 変更後の予約で必要な時間
 */
export function ticketChangePlan(daysBefore: number, oldHours: number, newHours: number): TicketChangePlan {
  if (daysBefore >= 2) {
    // 前々日以前：全額返還（新しい予約で改めて消費する）
    return { action: 'restore_full', restoreHours: oldHours, forfeitHours: 0 };
  }
  // 当日・前日
  if (newHours > oldHours) {
    return {
      action: 'blocked',
      restoreHours: 0,
      forfeitHours: 0,
      message: '当日・前日の時間延長はチケットでは承れません。追加分は新規のご予約をお願いします。',
    };
  }
  if (newHours === oldHours) {
    // 増減なし：付け替えのみ（返還・追加消費なし）
    return { action: 'move', restoreHours: 0, forfeitHours: 0 };
  }
  // 減少：減った分はキャンセル扱いで失効、残りは付け替え
  return { action: 'partial_forfeit', restoreHours: 0, forfeitHours: oldHours - newHours };
}
