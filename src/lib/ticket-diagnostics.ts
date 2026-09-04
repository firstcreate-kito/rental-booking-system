/**
 * チケット（回数券）が「予約フローのチケット選択に出るか」を診断する。
 *
 * 予約フローの実クエリ（repository.getUsableTicketsForSpace）は次の条件で絞り込む：
 *   status = 'active' AND remaining_hours > 0
 *   AND valid_from <= today AND valid_until >= today   ← 文字列比較
 *   AND（対象スペース無し OR 予約スペースが対象に含まれる）
 *
 * 本モジュールはスペース非依存の基礎条件（status/残時間/有効期間）を人間可読に説明する。
 * とくに valid_from/valid_until が 'YYYY-MM-DD' でない場合（例：'20260830'）は、
 * 文字列比較で利用開始前・期限切れと誤判定され、マイページには出るのに予約フローから
 * 消える——という不具合の原因になるため、明示的に検出する。
 */

export interface TicketLike {
  status: string;
  remaining_hours: number;
  valid_from: string;
  valid_until: string;
}

export interface TicketDiagnosis {
  /** 予約フローのチケット選択に出るか（対象スペースを予約した場合。スペース一致条件は別途） */
  selectable: boolean;
  checks: {
    activeStatus: boolean; // status === 'active'
    hasRemaining: boolean; // remaining_hours > 0
    started: boolean; // valid_from <= today（文字列比較）
    notExpired: boolean; // valid_until >= today（文字列比較）
  };
  validFromMalformed: boolean; // valid_from が 'YYYY-MM-DD' でない
  validUntilMalformed: boolean; // valid_until が 'YYYY-MM-DD' でない
  /** 選べない場合の理由（人間可読）。selectable=true のときは空配列。 */
  issues: string[];
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function diagnoseTicket(t: TicketLike, today: string): TicketDiagnosis {
  const status = (t.status ?? '').trim();
  const validFrom = (t.valid_from ?? '').trim();
  const validUntil = (t.valid_until ?? '').trim();
  const validFromMalformed = !YMD.test(validFrom);
  const validUntilMalformed = !YMD.test(validUntil);

  const activeStatus = status === 'active';
  const hasRemaining = Number(t.remaining_hours) > 0;
  // 予約フローと同じく文字列比較で判定する（実クエリの挙動を忠実に再現）
  const started = validFrom <= today;
  const notExpired = validUntil >= today;

  const issues: string[] = [];
  if (!activeStatus) issues.push(`ステータスが「${status || '（空）'}」で active ではありません`);
  if (!hasRemaining) issues.push('残り時間が 0 です');
  if (!started) {
    if (validFromMalformed) {
      issues.push(
        `利用開始日 valid_from が不正な形式（"${validFrom}"）のため、文字列比較で「利用開始前」と誤判定され予約フローから除外されています（"YYYY-MM-DD" 形式であるべき）`,
      );
    } else {
      issues.push(`利用開始日が未来です（valid_from=${validFrom} > 今日=${today}）`);
    }
  }
  if (!notExpired) {
    if (validUntilMalformed) {
      issues.push(
        `有効期限 valid_until が不正な形式（"${validUntil}"）のため、文字列比較で「期限切れ」と誤判定されています（"YYYY-MM-DD" 形式であるべき）`,
      );
    } else {
      issues.push(`有効期限が切れています（valid_until=${validUntil} < 今日=${today}）`);
    }
  }
  // 形式不正だが日付比較上は通ってしまうケースも注意喚起（将来の別日で挙動が変わりうる）
  if (started && validFromMalformed) {
    issues.push(`利用開始日 valid_from の形式が不正です（"${validFrom}"）。日付によっては誤判定の原因になります`);
  }
  if (notExpired && validUntilMalformed) {
    issues.push(`有効期限 valid_until の形式が不正です（"${validUntil}"）。日付によっては誤判定の原因になります`);
  }

  // selectable は予約フローの実クエリの挙動をそのまま再現する（＝顧客に実際どう見えるか）。
  // 形式不正（malformed）は selectable そのものではなく issues の注意喚起として扱う。
  const selectable = activeStatus && hasRemaining && started && notExpired;
  return {
    selectable,
    checks: { activeStatus, hasRemaining, started, notExpired },
    validFromMalformed,
    validUntilMalformed,
    issues,
  };
}
