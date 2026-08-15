/**
 * データ保持ポリシー（#57）: 一定期間（既定7年）を過ぎた顧客の個人情報を匿名化する。
 *
 * 方針:
 *  - 起点は「最終利用日（予約の利用日の最大）」。予約が無ければ「登録日(created_at)」。
 *    そこから満7年を過ぎ、かつ未来の有効予約（confirmed/tentative/pending/held で
 *    利用日が本日以降）が無い顧客を対象にする。
 *  - 会員・ゲスト双方が対象。ただしブラックリスト（is_blocked=1）はブロック維持のため除外。
 *  - 統計に使う情報（予約日・金額・利用目的・人数・スペース等）は残し、氏名・連絡先など
 *    の個人情報のみを匿名化する。会計証憑（7年保存）としての取引データは保持する。
 *  - 匿名化は不可逆。安全のため既定は「ドライラン」（対象件数のログのみ）。
 *    env.ANONYMIZE_ENABLED === 'true' のときだけ実際に書き換える。
 */
import type { AppBindings } from '../types';
import { todayJST, nowJST } from './clock';

type Env = AppBindings['Bindings'];

/** 保持年数（この年数を過ぎたら匿名化の対象）。会計証憑の保存年限に合わせて7年。 */
export const RETENTION_YEARS = 7;

/** 未来予約「有効」とみなすステータス（この予約が残っている顧客は対象外） */
export const ACTIVE_BOOKING_STATUSES = ['confirmed', 'tentative', 'pending', 'held'] as const;

/**
 * 'YYYY-MM-DD' から years 年だけ引いた 'YYYY-MM-DD' を返す（年の減算のみ・月日は据え置き）。
 * 2/29 のような日は存在しない年でも文字列上の境界としてそのまま扱う（比較にのみ使うため問題ない）。
 */
export function subtractYears(ymd: string, years: number): string {
  const [y, m, d] = ymd.split('-');
  const yy = String(Number(y) - years).padStart(4, '0');
  return `${yy}-${m}-${d}`;
}

/** 匿名化の締切日（この日以前が起点なら対象）。today から RETENTION_YEARS 年前。 */
export function anonymizationCutoff(today: string = todayJST()): string {
  return subtractYears(today, RETENTION_YEARS);
}

/** 匿名化の判定に使う顧客の要約 */
export interface RetentionCandidate {
  /** 最終利用日（'YYYY-MM-DD'）。予約が一度も無ければ null。 */
  lastUseDate: string | null;
  /** 登録日（'YYYY-MM-DD'。created_at の日付部分） */
  createdDate: string;
  /** 未来の有効予約の件数（0 なら対象になり得る） */
  futureActiveCount: number;
}

/**
 * 単一顧客が匿名化対象かを判定（純粋関数・テスト用）。
 * 起点 = lastUseDate ?? createdDate。起点 <= cutoff かつ 未来有効予約が0のとき true。
 */
export function isEligibleForAnonymization(c: RetentionCandidate, cutoff: string): boolean {
  if (c.futureActiveCount > 0) return false;
  const anchor = c.lastUseDate ?? c.createdDate;
  return anchor <= cutoff;
}

/**
 * 匿名化対象の顧客ID一覧を取得する。
 * ・anonymized_at が未設定（未処理）
 * ・is_blocked = 0（ブラックリストは除外）
 * ・未来の有効予約が無い
 * ・起点（最終利用日 or 登録日）が cutoff 以前
 */
export async function findAnonymizationCandidates(db: D1Database, today: string, cutoff: string): Promise<string[]> {
  const placeholders = ACTIVE_BOOKING_STATUSES.map(() => '?').join(',');
  const sql = `
    SELECT id FROM (
      SELECT
        c.id AS id,
        COALESCE(
          (SELECT MAX(b.date) FROM bookings b JOIN booking_groups g ON b.group_id = g.id WHERE g.customer_id = c.id),
          date(c.created_at)
        ) AS anchor,
        (SELECT COUNT(*) FROM bookings b JOIN booking_groups g ON b.group_id = g.id
           WHERE g.customer_id = c.id AND b.date >= ? AND b.status IN (${placeholders})) AS future_active
      FROM customers c
      WHERE c.anonymized_at IS NULL AND c.is_blocked = 0
    )
    WHERE future_active = 0 AND anchor <= ?`;
  const { results } = await db
    .prepare(sql)
    .bind(today, ...ACTIVE_BOOKING_STATUSES, cutoff)
    .all<{ id: string }>();
  return (results ?? []).map((r) => r.id);
}

/**
 * 顧客1件の個人情報を匿名化する（顧客本体＋その予約グループの氏名系フィールド）。
 * 冪等: anonymized_at をセットし、二度目以降は候補に上がらない。
 */
export async function anonymizeCustomer(db: D1Database, id: string, now: string): Promise<void> {
  // メールは UNIQUE 制約があるため、衝突しない非到達アドレスに置換する。
  const anonEmail = `anon-${id}@anonymized.invalid`;
  await db.batch([
    db
      .prepare(
        `UPDATE customers SET
           email = ?, password_hash = NULL, company_name = NULL, contact_name = '（匿名化済み）',
           phone = '000-0000-0000', postal_code = NULL, address = NULL, invoice_number = NULL,
           line_user_id = NULL, staff_memo = NULL, last_login_at = NULL, anonymized_at = ?
         WHERE id = ? AND anonymized_at IS NULL`,
      )
      .bind(anonEmail, now, id),
    // 予約グループの個人が特定され得るフィールド（宛名・イベント名・メモ）を匿名化。
    // 予約日・金額・利用目的・人数などの統計・会計データは保持する。
    db
      .prepare(
        `UPDATE booking_groups SET event_name = '（匿名化済み）', invoice_name = NULL, note = NULL
         WHERE customer_id = ?`,
      )
      .bind(id),
  ]);
}

/** 匿名化スイープの結果 */
export interface RetentionResult {
  /** 対象件数 */
  candidates: number;
  /** 実際に匿名化した件数（ドライランでは 0） */
  anonymized: number;
  /** ドライラン（変更なし）だったか */
  dryRun: boolean;
  /** 締切日（この日以前が起点なら対象） */
  cutoff: string;
}

/**
 * データ保持ポリシーの日次スイープ（#57）。
 * env.ANONYMIZE_ENABLED === 'true' のときだけ実際に匿名化し、それ以外は件数のログのみ。
 */
export async function runDataRetention(
  env: Env,
  opts: { today?: string; now?: string } = {},
): Promise<RetentionResult> {
  const today = opts.today ?? todayJST();
  const now = opts.now ?? nowJST();
  const cutoff = anonymizationCutoff(today);
  const dryRun = env.ANONYMIZE_ENABLED !== 'true';

  const ids = await findAnonymizationCandidates(env.DB, today, cutoff);
  let anonymized = 0;
  if (!dryRun) {
    for (const id of ids) {
      await anonymizeCustomer(env.DB, id, now);
      anonymized++;
    }
  }
  console.log(
    `[retention] cutoff<=${cutoff} candidates=${ids.length} ${dryRun ? 'dry-run (no changes)' : `anonymized=${anonymized}`}`,
  );
  return { candidates: ids.length, anonymized, dryRun, cutoff };
}
