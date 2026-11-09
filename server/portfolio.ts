import type { Loan, PromiseRecord, User } from '../shared/types';
import { query, transaction } from './db';
import {
  canonicalJson,
  checksum,
  dateText,
  decodeJson,
  HttpError,
  instant,
} from './http';
import { rankLoans, todayIST } from './policy';

export type Row = Record<string, unknown>;
export type Executor = { query: typeof query };

export function publicUser(row: Row): User {
  return {
    id: String(row.id),
    branch_id: String(row.branch_id),
    full_name: String(row.full_name),
    email: String(row.email),
    role: row.role as User['role'],
  };
}

const optionalText = (value: unknown) => (value == null ? null : String(value));

export function mapPromise(row: Row, day: string): PromiseRecord {
  const due = dateText(row.due_date);
  let status = String(row.status);
  const amount = Number(row.promised_amount);
  if (status === 'active' && Number(row.paid_by_due ?? 0) >= amount)
    status = 'kept';
  if (status === 'active' && due < day) status = 'broken';
  return {
    id: String(row.id),
    loan_id: String(row.loan_id),
    promised_amount: amount,
    due_date: due,
    status,
    version: Number(row.version),
  };
}

export async function currentPromise(
  executor: Executor,
  loanId: string,
  day: string,
) {
  const row = (
    await executor.query(
      "SELECT p.*, COALESCE((SELECT SUM(m.amount) FROM mock_payments m WHERE m.promise_id=p.id AND (m.occurred_at AT TIME ZONE 'Asia/Kolkata')::date<=p.due_date),0) AS paid_by_due FROM promises p WHERE p.loan_id=$1 AND p.status<>'superseded' ORDER BY p.version DESC,p.created_at DESC,p.id DESC LIMIT 1",
      [loanId],
    )
  ).rows[0];
  return row ? mapPromise(row, day) : null;
}

export async function scopedLoan(
  executor: Executor,
  user: User,
  loanId: string,
  lock = false,
): Promise<Row> {
  const sql = [
    'SELECT l.*, b.display_name AS borrower_name,b.phone_number,b.preferred_language,b.address,b.external_borrower_id',
    'FROM loans l JOIN borrowers b ON b.id=l.borrower_id',
    'WHERE l.id=$1 AND l.branch_id=$2 AND ($3::uuid IS NULL OR l.assigned_officer_id=$3)',
    lock ? 'FOR UPDATE OF l' : '',
  ].join(' ');
  const loan = (
    await executor.query(sql, [
      loanId,
      user.branch_id,
      user.role === 'field_officer' ? user.id : null,
    ])
  ).rows[0];
  if (!loan)
    throw new HttpError(
      404,
      'This case is unavailable or has been reassigned.',
    );
  return loan;
}

export async function scopedOfficers(user: User) {
  return (
    await query(
      "SELECT id,branch_id,full_name,email,role FROM users WHERE branch_id=$1 AND role='field_officer' AND is_active ORDER BY full_name,id",
      [user.branch_id],
    )
  ).rows.map(publicUser);
}

const loanSelect = [
  'SELECT l.*, b.display_name AS borrower_name,b.external_borrower_id,b.phone_number,b.address,b.pincode,b.preferred_language,',
  'CASE WHEN u.is_active THEN u.full_name ELSE NULL END AS officer_name, u.is_active AS officer_active,',
  'COALESCE(bc.work_date,l.last_handled_date) AS effective_handled_date,',
  'p.id AS promise_id,p.status AS promise_status,p.due_date AS promise_due_date,p.version AS promise_version,p.promised_amount,',
  "COALESCE((SELECT SUM(m.amount) FROM mock_payments m WHERE m.promise_id=p.id AND (m.occurred_at AT TIME ZONE 'Asia/Kolkata')::date<=p.due_date),0) AS paid_by_due,",
  "CASE WHEN EXISTS (SELECT 1 FROM promise_conflicts cf WHERE cf.loan_id=l.id AND cf.status='open') THEN 'Promise needs manager review' ELSE l.hold_reason END AS effective_hold",
  'FROM loans l JOIN borrowers b ON b.id=l.borrower_id',
  'LEFT JOIN users u ON u.id=l.assigned_officer_id',
  'LEFT JOIN borrower_contacts bc ON bc.borrower_id=l.borrower_id AND bc.work_date=$2',
  "LEFT JOIN LATERAL (SELECT id,status,due_date,version,promised_amount FROM promises WHERE loan_id=l.id AND status<>'superseded' ORDER BY version DESC,created_at DESC,id DESC LIMIT 1) p ON true",
  'WHERE l.branch_id=$1 AND ($3::uuid IS NULL OR l.assigned_officer_id=$3)',
  'ORDER BY l.external_loan_id',
].join(' ');

function mapLoan(
  row: Row,
  day: string,
): Loan & { external_borrower_id: string; manager_override?: boolean } {
  const dpd = Number(row.dpd);
  return {
    id: String(row.id),
    external_loan_id: String(row.external_loan_id),
    borrower_id: String(row.borrower_id),
    external_borrower_id: String(row.external_borrower_id),
    branch_id: String(row.branch_id),
    assigned_officer_id: row.officer_active
      ? optionalText(row.assigned_officer_id)
      : null,
    borrower_name: String(row.borrower_name),
    officer_name: optionalText(row.officer_name),
    phone_number: optionalText(row.phone_number),
    address: optionalText(row.address),
    pincode: optionalText(row.pincode),
    preferred_language: String(row.preferred_language),
    dpd,
    outstanding_amount: Number(row.outstanding_amount),
    overdue_amount: Number(row.overdue_amount),
    report_date: dateText(row.report_date),
    next_action_date: dateText(row.next_action_date),
    late_installments:
      row.late_installments == null ? null : Number(row.late_installments),
    last_handled_date:
      row.effective_handled_date == null
        ? null
        : dateText(row.effective_handled_date),
    hold_reason: optionalText(row.effective_hold),
    version: Number(row.version),
    promise: row.promise_id
      ? mapPromise(
          {
            id: row.promise_id,
            loan_id: row.id,
            promised_amount: row.promised_amount,
            due_date: row.promise_due_date,
            status: row.promise_status,
            version: row.promise_version,
            paid_by_due: row.paid_by_due,
          },
          day,
        )
      : null,
    state: 'ready',
    score: null,
    rank: null,
    reasons: [],
    group: dpd <= 30 ? 'early' : 'recovery',
  };
}

export function orderingFact(loan: Loan) {
  return [
    loan.next_action_date,
    loan.report_date,
    loan.dpd,
    loan.promise?.status === 'broken',
    loan.late_installments,
    loan.overdue_amount,
    loan.assigned_officer_id,
  ];
}

async function saveRun(
  user: User,
  officerId: string,
  day: string,
  time: Date,
  loans: Loan[],
) {
  const ready = loans.filter((loan) => loan.rank != null);
  if (!ready.length) return;
  const facts = ready.map((loan) => ({
    loan_id: loan.id,
    base_rank: loan.rank,
    score: loan.score,
    reasons: loan.reasons,
    input_facts: { ordering: orderingFact(loan), group: loan.group },
  }));
  const fingerprint = checksum(canonicalJson(facts));
  await transaction(async (tx) => {
    const run = (
      await tx.query(
        "INSERT INTO priority_runs(officer_id,branch_id,work_date,policy_version,fingerprint,eligible_count,computed_at) VALUES ($1,$2,$3,'collections_queue_v1',$4,$5,$6) ON CONFLICT(officer_id,work_date,fingerprint) DO NOTHING RETURNING id",
        [
          officerId,
          user.branch_id,
          day,
          fingerprint,
          facts.length,
          time.toISOString(),
        ],
      )
    ).rows[0];
    if (!run) return;
    await tx.query(
      'INSERT INTO loan_priority_scores(run_id,loan_id,base_rank,score,reasons,input_facts) SELECT $1,d.loan_id,d.base_rank,d.score,d.reasons,d.input_facts FROM jsonb_to_recordset($2::jsonb) AS d(loan_id uuid,base_rank integer,score numeric,reasons jsonb,input_facts jsonb)',
      [run.id, JSON.stringify(facts)],
    );
  });
}

export async function portfolio(
  user: User,
  time: Date,
  persist = true,
  executor: Executor = { query },
): Promise<Loan[]> {
  const day = todayIST(time);
  const raw = await executor.query(loanSelect, [
    user.branch_id,
    day,
    user.role === 'field_officer' ? user.id : null,
  ]);
  const loans = raw.rows.map((row) => mapLoan(row, day));
  const groups = new Map<string, typeof loans>();
  for (const loan of loans) {
    const key = loan.assigned_officer_id ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(loan);
  }
  const settings = await executor.query(
    'SELECT u.id,qs.next_group,o.loan_ids,o.ordering_facts,o.created_at AS override_created_at FROM users u LEFT JOIN officer_queue_state qs ON qs.officer_id=u.id AND qs.work_date=$2 LEFT JOIN priority_overrides o ON o.officer_id=u.id AND o.work_date=$2 WHERE u.branch_id=$1 AND ($3::uuid IS NULL OR u.id=$3)',
    [user.branch_id, day, user.role === 'field_officer' ? user.id : null],
  );
  const results: Loan[] = [];
  for (const [officerId, group] of groups) {
    const setting = settings.rows.find((row) => row.id === officerId);
    const ranked = rankLoans(
      group,
      setting?.next_group === 'recovery' ? 'recovery' : 'early',
      time,
    );
    if (officerId && persist) await saveRun(user, officerId, day, time, ranked);
    if (setting?.loan_ids) {
      const ordered = decodeJson<string[]>(setting.loan_ids);
      const facts = decodeJson<Record<string, unknown>>(setting.ordering_facts);
      const ready = ranked.filter((loan) => loan.rank != null);
      if (
        ready.every(
          (loan) =>
            ordered.includes(loan.id) &&
            canonicalJson(facts[loan.id]) === canonicalJson(orderingFact(loan)),
        )
      ) {
        ready.sort((a, b) => ordered.indexOf(a.id) - ordered.indexOf(b.id));
        const overridden: (Loan & { manager_override: boolean })[] = ready.map(
          (loan) => ({ ...loan, manager_override: true }),
        );
        results.push(
          ...overridden,
          ...ranked.filter((loan) => loan.rank == null),
        );
        continue;
      }
      await executor.query(
        'DELETE FROM priority_overrides WHERE officer_id=$1 AND work_date=$2 AND created_at=$3 AND loan_ids=$4::jsonb AND ordering_facts=$5::jsonb',
        [
          officerId,
          day,
          setting.override_created_at,
          JSON.stringify(ordered),
          JSON.stringify(facts),
        ],
      );
      const invalidated: (Loan & { override_invalidated: string })[] =
        ranked.map((loan) => ({
          ...loan,
          override_invalidated:
            'The ready cases or ordering facts changed. Review the new base order.',
        }));
      results.push(...invalidated);
      continue;
    }
    results.push(...ranked);
  }
  const stateNames: Record<string, string> = {
    actionable: 'ready',
    needs_data_check: 'stale',
    needs_review: 'review',
    handled_today: 'handled',
  };
  return results
    .sort((a, b) => Number(a.rank == null) - Number(b.rank == null))
    .map((loan) => ({ ...loan, state: stateNames[loan.state] ?? loan.state }));
}

export async function loanDetail(user: User, loanId: string, time: Date) {
  return transaction(async (tx) => {
    await scopedLoan(tx, user, loanId, true);
    const loan = (await portfolio(user, time, false, tx)).find(
      (item) => item.id === loanId,
    );
    if (!loan)
      throw new HttpError(
        404,
        'This case is unavailable or has been reassigned.',
      );
    const activities = await tx.query(
      'SELECT a.id,a.outcome,a.contact_method,a.notes,a.occurred_at,a.latitude,a.longitude,a.location_accuracy_m,u.full_name AS officer_name FROM officer_activities a JOIN users u ON u.id=a.officer_id WHERE a.loan_id=$1 ORDER BY a.occurred_at DESC,a.id LIMIT 100',
      [loanId],
    );
    const payments = await tx.query(
      'SELECT id,amount,reference,occurred_at FROM mock_payments WHERE loan_id=$1 ORDER BY occurred_at DESC,id LIMIT 100',
      [loanId],
    );
    const contacts = await tx.query(
      'SELECT id,method,allowed,reason,message,created_at AS occurred_at FROM contact_attempts WHERE loan_id=$1 ORDER BY created_at DESC,id LIMIT 100',
      [loanId],
    );
    return {
      loan,
      activities: activities.rows.map((row) => ({
        ...row,
        occurred_at: instant(row.occurred_at),
      })),
      payments: payments.rows.map((row) => ({
        ...row,
        amount: Number(row.amount),
        occurred_at: instant(row.occurred_at),
      })),
      contacts: contacts.rows.map((row) => ({
        ...row,
        occurred_at: instant(row.occurred_at),
      })),
    };
  });
}
