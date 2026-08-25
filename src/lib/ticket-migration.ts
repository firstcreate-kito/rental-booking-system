import { issueTicket } from '../db/repository';

// 既存チケットの対象スペース対応（#82）
// 'ab' … 名駅防音室A・B共通 / 'higashibetsuin' … 東別院24hグランドピアノ練習室
export const TICKET_SCOPE_SPACES: Record<string, string[]> = {
  ab: ['meieki-piano-a', 'meieki-piano-b'],
  higashibetsuin: ['higashibetsuin-piano-24h'],
};

export const TICKET_SCOPE_NAME: Record<string, string> = {
  ab: '名駅防音室A・B共通チケット（移行）',
  higashibetsuin: '東別院グランドピアノ練習室チケット（移行）',
};

export interface PendingTicketRow {
  id: string;
  email: string;
  name: string | null;
  scope: string;
  remaining_hours: number;
  valid_until: string;
  legacy_code: string | null;
  note: string | null;
}

export interface GrantedTicket {
  scope: string;
  name: string;
  remainingHours: number;
  validUntil: string;
}

/**
 * メール一致で「付与待ちチケット」を会員へ自動付与する（#82）。
 * 会員登録／ログイン（マイページ表示）の入口から呼ぶ。未付与のものだけを対象にし、
 * 付与済みは skip するので何度呼んでも二重付与しない（idempotent）。
 *
 * @returns 今回付与したチケットの一覧（0件なら何もしなかった）
 */
export async function claimPendingTicketsForCustomer(
  db: D1Database,
  customerId: string,
  email: string,
  today: string,
): Promise<GrantedTicket[]> {
  const key = (email ?? '').trim().toLowerCase();
  if (!key) return [];
  const { results } = await db
    .prepare('SELECT * FROM pending_tickets WHERE email = ? AND claimed_at IS NULL')
    .bind(key)
    .all<PendingTicketRow>();
  if (!results || results.length === 0) return [];

  const now = today; // 'YYYY-MM-DD'（issueTicket は purchased_at にそのまま入る）
  const granted: GrantedTicket[] = [];
  for (const p of results) {
    const spaceIds = TICKET_SCOPE_SPACES[p.scope] ?? [];
    if (spaceIds.length === 0) continue; // 未知の scope は安全側で skip（誤付与防止）
    const name = TICKET_SCOPE_NAME[p.scope] ?? 'チケット（移行）';
    // 残時間ぶんを発行（total=remaining）。有効期限は移行時に確定済みの valid_until。
    const ticketId = await issueTicket(
      db,
      {
        customerId,
        name,
        totalHours: p.remaining_hours,
        validFrom: today,
        validUntil: p.valid_until,
        spaceIds,
        productId: null,
      },
      now,
    );
    await db
      .prepare('UPDATE pending_tickets SET claimed_at = ?, claimed_customer_id = ?, claimed_ticket_id = ? WHERE id = ? AND claimed_at IS NULL')
      .bind(now, customerId, ticketId, p.id)
      .run();
    granted.push({ scope: p.scope, name, remainingHours: p.remaining_hours, validUntil: p.valid_until });
  }
  return granted;
}
