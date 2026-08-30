/**
 * 公開切替：移行したBooklyのお客様を「会員」に紐付ける（案A）。
 *
 * 背景：Bookly予約の取り込み（bookly-import.ts）では booking_groups.customer_id=NULL のため、
 *   移行分のお客様はマイページで自分の予約を見られず、変更・キャンセルもできない。
 *   一方、先々の顧客予約(customer/customer_ticket)のメールは顧客CSVと100%一致することが分かった。
 *   そこで「チケット残数の引き継ぎ」と同じ発想で、メール突合により会員を用意し、
 *   移行予約に customer_id を付与する。
 *
 * 安全性：移行予約には新システム側の決済実体が無い（入金は旧Bookly側）。よって自己キャンセルで
 *   自動返金はしない設計＝マイページの「変更・キャンセルは申請→管理者承認」フローで受ける
 *   （mypage の change-request は元々承認制なので、customer_id を付けるだけで安全に成立する）。
 *
 * 対象：src/data/bookly-customers.json（cutoff=2026-08-30 以降の顧客予約に紐づく45人・氏名/電話つき）。
 *   それ以外の顧客は破棄＝新規登録に委ねる（ユーザー方針）。
 * 冪等：会員はメールでupsert、紐付けは customer_id IS NULL のグループのみ。再実行しても二重化しない。
 */
import type { Env } from '../types';
import { loadBooklySlots } from './bookly-import';
import { nowJST, todayYmdJST } from './clock';
import { claimPendingTicketsForCustomer } from './ticket-migration';
import customersData from '../data/bookly-customers.json';

export interface BooklyCustomer {
  email: string;
  contactName: string;
  phone: string;
}
interface CustomersFile {
  meta: Record<string, unknown>;
  customers: BooklyCustomer[];
}
export function loadBooklyCustomers(): BooklyCustomer[] {
  return (customersData as unknown as CustomersFile).customers ?? [];
}

const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase();

export interface CustomerLinkResult {
  dryRun: boolean;
  rosterSize: number;
  customersCreated: number;     // 新規作成した会員
  customersExisting: number;    // 既存だった会員
  profilesFilled: number;       // 空だった氏名/電話を補完した数
  groupsLinked: number;         // customer_id を付与した移行グループ
  groupsAlreadyLinked: number;  // 既に紐付いていた移行グループ
  customersWithPendingTickets: number; // 45人のうち付与待ちチケットも持つ人（2軸）
  ticketsGranted: number;       // 今回この移行で付与した回数券の枚数（本実行時・チケット移行#82が先に投入済みの場合）
  perCustomer: Array<{ email: string; contactName: string; groups: number }>;
  warnings: string[];
}

/** 付与待ちチケットのメール集合（未claim）。#82未適用なら空（テーブル無し）。 */
async function pendingTicketEmails(env: Env): Promise<Set<string>> {
  try {
    const { results } = await env.DB
      .prepare('SELECT DISTINCT email FROM pending_tickets WHERE claimed_at IS NULL')
      .all<{ email: string }>();
    return new Set((results ?? []).map((r) => norm(r.email)));
  } catch {
    return new Set(); // pending_tickets 未作成（チケット移行#82が未実施）
  }
}

/** email（小文字）→ そのお客様が持つ移行グループID一覧 を作る */
async function buildEmailToGroups(env: Env): Promise<Map<string, Set<string>>> {
  const db = env.DB;
  // booklyKey → email（顧客予約のみ）
  const keyToEmail = new Map<string, string>();
  for (const s of loadBooklySlots()) {
    if ((s.category === 'customer' || s.category === 'customer_ticket') && norm(s.email)) {
      keyToEmail.set(s.booklyKey, norm(s.email));
    }
  }
  // bookly_imports: bookly_key → group_id
  const { results } = await db
    .prepare('SELECT bookly_key, group_id FROM bookly_imports')
    .all<{ bookly_key: string; group_id: string }>();
  const emailToGroups = new Map<string, Set<string>>();
  for (const r of results ?? []) {
    const email = keyToEmail.get(r.bookly_key);
    if (!email) continue; // ブロック等（顧客不在）はスキップ
    if (!emailToGroups.has(email)) emailToGroups.set(email, new Set());
    emailToGroups.get(email)!.add(r.group_id);
  }
  return emailToGroups;
}

/**
 * 会員化＋紐付けを実行（dryRun / 本実行 共通）。
 * dryRun のときは書き込まず、件数だけ返す。
 */
export async function runCustomerLink(env: Env, opts: { dryRun: boolean }): Promise<CustomerLinkResult> {
  const db = env.DB;
  const roster = loadBooklyCustomers();
  const now = nowJST();
  const today = todayYmdJST();
  const emailToGroups = await buildEmailToGroups(env);
  const pendingTickets = await pendingTicketEmails(env);

  // 本番D1の逐次往復（会員数×予約数の SELECT）で Worker 実行上限に触れないよう、事前に一括ロードする。
  // ① ロースターのメールに一致する既存会員を IN 句でまとめて取得
  const rosterEmails = [...new Set(roster.map((c) => norm(c.email)).filter(Boolean))];
  const existingByEmail = new Map<string, { id: string; contact_name: string | null; phone: string | null }>();
  for (let i = 0; i < rosterEmails.length; i += 100) {
    const batch = rosterEmails.slice(i, i + 100);
    const ph = batch.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT id, email, contact_name, phone FROM customers WHERE email IN (${ph})`)
      .bind(...batch)
      .all<{ id: string; email: string; contact_name: string | null; phone: string | null }>();
    for (const r of results ?? []) existingByEmail.set(norm(r.email), { id: r.id, contact_name: r.contact_name, phone: r.phone });
  }
  // ② 移行グループ（source='bookly'）の id→customer_id を一括取得
  const booklyGroupCustomer = new Map<string, string | null>();
  {
    const { results } = await db
      .prepare("SELECT id, customer_id FROM booking_groups WHERE source = 'bookly'")
      .all<{ id: string; customer_id: string | null }>();
    for (const r of results ?? []) booklyGroupCustomer.set(r.id, r.customer_id);
  }

  const result: CustomerLinkResult = {
    dryRun: opts.dryRun,
    rosterSize: roster.length,
    customersCreated: 0,
    customersExisting: 0,
    profilesFilled: 0,
    groupsLinked: 0,
    groupsAlreadyLinked: 0,
    customersWithPendingTickets: 0,
    ticketsGranted: 0,
    perCustomer: [],
    warnings: [],
  };

  for (const cust of roster) {
    const email = norm(cust.email);
    const groupIds = [...(emailToGroups.get(email) ?? [])];
    result.perCustomer.push({ email, contactName: cust.contactName, groups: groupIds.length });
    if (groupIds.length === 0) {
      result.warnings.push(`予約グループが見つからない（先に取り込みが必要）: ${email}`);
      continue;
    }

    // 会員をメールでupsert（パスワードなし＝マジックリンクでログイン可）。事前ロードから引く。
    const existing = existingByEmail.get(email);

    let customerId: string;
    if (existing) {
      result.customersExisting++;
      customerId = existing.id;
      // 氏名/電話が空なら補完
      const needName = !String(existing.contact_name ?? '').trim() && cust.contactName;
      const needPhone = !String(existing.phone ?? '').trim() && cust.phone;
      if ((needName || needPhone) && !opts.dryRun) {
        await db
          .prepare('UPDATE customers SET contact_name = COALESCE(NULLIF(?, \'\'), contact_name), phone = COALESCE(NULLIF(?, \'\'), phone) WHERE id = ?')
          .bind(needName ? cust.contactName : '', needPhone ? cust.phone : '', customerId)
          .run();
      }
      if (needName || needPhone) result.profilesFilled++;
    } else {
      result.customersCreated++;
      customerId = crypto.randomUUID();
      if (!opts.dryRun) {
        await db
          .prepare(
            `INSERT INTO customers (id, email, is_registered, contact_name, phone, status_id, created_at)
             VALUES (?, ?, 1, ?, ?, 'general', ?)`,
          )
          .bind(customerId, email, cust.contactName || '', cust.phone || '', now)
          .run();
      }
    }

    // 移行グループに customer_id を付与（source='bookly' かつ 未紐付けのみ）。事前ロードから引く。
    for (const gid of groupIds) {
      if (!booklyGroupCustomer.has(gid)) continue; // source!='bookly' 等は対象外
      if (booklyGroupCustomer.get(gid)) { result.groupsAlreadyLinked++; continue; }
      if (!opts.dryRun) {
        await db
          .prepare("UPDATE booking_groups SET customer_id = ? WHERE id = ? AND source = 'bookly' AND customer_id IS NULL")
          .bind(customerId, gid)
          .run();
        booklyGroupCustomer.set(gid, customerId); // 以降の重複カウント防止
      }
      result.groupsLinked++;
    }

    // 2軸連携：このお客様が付与待ちチケット(#82)も持つなら、同じ会員に付与する。
    // どちらもメールがキーなので同一会員に集約される。本実行時のみ・冪等（claimは付与済みskip）。
    if (pendingTickets.has(email)) {
      result.customersWithPendingTickets++;
      if (!opts.dryRun) {
        try {
          const granted = await claimPendingTicketsForCustomer(db, customerId, email, today);
          result.ticketsGranted += granted.length;
        } catch (err) {
          result.warnings.push(`チケット付与に失敗（会員化は成立）: ${email}: ${(err as Error).message}`);
        }
      }
    }
  }

  return result;
}

export interface CustomerUnlinkResult {
  groupsUnlinked: number;
}

/**
 * 紐付けの取り消し（会員レコードは残す・customer_id を外すだけ）。
 * 取り込み自体のロールバック（rollbackBooklyImport）はグループごと消えるので、こちらは
 * 「取り込みは残したまま紐付けだけ戻す」用。会員アカウントは削除しない（既にログイン済みの恐れ）。
 */
export async function unlinkBooklyCustomers(env: Env): Promise<CustomerUnlinkResult> {
  const db = env.DB;
  const { meta } = await db
    .prepare("UPDATE booking_groups SET customer_id = NULL WHERE source = 'bookly' AND customer_id IS NOT NULL")
    .run();
  const changes = (meta as { changes?: number } | undefined)?.changes ?? 0;
  return { groupsUnlinked: changes };
}
