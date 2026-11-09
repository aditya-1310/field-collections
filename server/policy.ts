import type { Loan } from '../shared/types';

type Group = Loan['group'];
const calendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  hourCycle: 'h23',
});

export const todayIST = (now = new Date()) => calendar.format(now);
export const contactAllowed = (now = new Date()) => {
  const hour = Number(clock.format(now));
  return hour >= 8 && hour < 19;
};

export function addDays(day: string, days: number) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const POLICY_VERSION = 'collections_queue_v1';
const opposite = (group: Group): Group =>
  group === 'early' ? 'recovery' : 'early';
const missedPromise = (loan: Loan) => loan.promise?.status === 'broken';

function actionState(loan: Loan, today: string): string {
  if (loan.report_date !== today) return 'needs_data_check';
  if ((loan.dpd === 0) !== (loan.overdue_amount === 0))
    return 'needs_data_check';
  if (loan.hold_reason) return 'needs_review';
  if (loan.dpd === 0) return 'cleared';
  if (!loan.assigned_officer_id) return 'unassigned';
  if (loan.last_handled_date === today) return 'handled_today';
  if (
    loan.next_action_date > today ||
    (loan.promise?.status === 'active' && loan.promise.due_date > today)
  ) {
    return 'scheduled';
  }
  return 'actionable';
}

function groupBy<T>(rows: T[], keyFor: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFor(row);
    const members = groups.get(key);
    if (members) members.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function orderGroup(rows: Loan[], today: string) {
  const byDpd = groupBy(rows, (loan) => String(loan.dpd));
  const ordered: Loan[] = [];
  for (const dpd of [...byDpd.keys()].sort((a, b) => Number(b) - Number(a))) {
    const sameDpd = byDpd.get(dpd)!;
    for (const broken of [true, false]) {
      const tied = sameDpd.filter((loan) => missedPromise(loan) === broken);
      const comparableHistory = tied.every(
        (loan) => loan.late_installments !== null,
      );
      tied.sort((a, b) => {
        if (comparableHistory && a.late_installments !== b.late_installments) {
          return b.late_installments! - a.late_installments!;
        }
        return (
          b.overdue_amount - a.overdue_amount ||
          a.external_loan_id.localeCompare(b.external_loan_id)
        );
      });
      for (const loan of tied) {
        const reasons: string[] = [];
        if (loan.next_action_date < today)
          reasons.push('Follow-up carried over');
        reasons.push(`${loan.dpd} days past due`);
        if (broken) reasons.push('Unfulfilled payment promise');
        if (comparableHistory && loan.late_installments! > 0) {
          reasons.push(
            `${loan.late_installments} of 3 previous installments paid late`,
          );
        }
        if (
          loan.promise?.status === 'active' &&
          loan.promise.due_date === today
        )
          reasons.push('Promise due today');
        reasons.push(
          loan.group === 'early' ? 'Early overdue group' : 'Recovery group',
        );
        loan.reasons = reasons.slice(0, 3);
        ordered.push(loan);
      }
    }
  }
  return ordered;
}

const stateReason: Record<string, string> = {
  needs_data_check: 'Check the latest financial report',
  needs_review: 'Manager review required',
  cleared: 'No overdue amount reported',
  unassigned: 'Assign an active field officer',
  handled_today: 'Borrower already handled today',
  scheduled: 'Follow-up scheduled for a later date',
};

export function rankLoans(
  rows: Loan[],
  nextGroup: Group = 'early',
  now = new Date(),
): Loan[] {
  const today = todayIST(now);
  const prepared = rows.map((row): Loan => {
    const state = actionState(row, today);
    return {
      ...row,
      state,
      rank: null,
      score: null,
      group: row.dpd <= 30 ? 'early' : 'recovery',
      reasons: state === 'actionable' ? [] : [stateReason[state]],
    };
  });
  const pending = prepared.filter((row) => row.state !== 'actionable');
  const byDate = groupBy(
    prepared.filter((row) => row.state === 'actionable'),
    (row) => row.next_action_date,
  );
  const ordered: Loan[] = [];
  let turn = nextGroup;
  for (const date of [...byDate.keys()].sort()) {
    const due = byDate.get(date)!;
    const queues = {
      early: orderGroup(
        due.filter((row) => row.group === 'early'),
        today,
      ),
      recovery: orderGroup(
        due.filter((row) => row.group === 'recovery'),
        today,
      ),
    };
    const cursor = { early: 0, recovery: 0 };
    while (
      cursor.early < queues.early.length ||
      cursor.recovery < queues.recovery.length
    ) {
      const selected =
        cursor[turn] < queues[turn].length ? turn : opposite(turn);
      ordered.push(queues[selected][cursor[selected]++]);
      turn = opposite(selected);
    }
  }
  const count = ordered.length;
  ordered.forEach((row, index) => {
    row.rank = index + 1;
    row.score = Math.round((10000 * (count - index)) / count) / 100;
  });
  return ordered.concat(
    pending.sort(
      (a, b) =>
        a.next_action_date.localeCompare(b.next_action_date) ||
        b.dpd - a.dpd ||
        a.external_loan_id.localeCompare(b.external_loan_id),
    ),
  );
}
