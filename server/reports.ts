import { Router } from 'express';
import { z } from 'zod';
import type { User } from '../shared/types';
import { query, transaction } from './db';
import {
  canonicalJson,
  checksum,
  dateText,
  HttpError,
  id,
  instant,
  note,
  shiftDay,
} from './http';
import { orderingFact, portfolio, type Executor, type Row } from './portfolio';
import { todayIST } from './policy';
import { currentUser, managerOnly } from './routes';

async function rollRate(user: User, today: string) {
  const dates = (
    await query(
      'SELECT DISTINCT report_date FROM loan_daily_history WHERE branch_id=$1 AND report_date<=$2 ORDER BY report_date DESC LIMIT 32',
      [user.branch_id, today],
    )
  ).rows.map((row) => dateText(row.report_date));
  const end = dates[0] ?? today;
  const start =
    dates.find((day) => day <= shiftDay(end, -7)) ?? dates.at(-1) ?? end;
  if (start === end) {
    return {
      rate: null,
      baseline: 0,
      known: 0,
      rolled: 0,
      unknown: 0,
      further: 0,
      start_date: start,
      end_date: end,
      lower_bound: null,
      upper_bound: null,
    };
  }
  const row = (
    await query(
      [
        'SELECT COUNT(*) AS baseline, COUNT(f.loan_id) AS known,',
        'COUNT(*) FILTER(WHERE f.dpd BETWEEN 31 AND 60) AS rolled,',
        'COUNT(*) FILTER(WHERE f.dpd>60) AS further',
        'FROM loan_daily_history s LEFT JOIN loan_daily_history f ON f.loan_id=s.loan_id AND f.report_date=$3 AND f.branch_id=s.branch_id',
        'WHERE s.branch_id=$1 AND s.report_date=$2 AND s.dpd BETWEEN 1 AND 30',
      ].join(' '),
      [user.branch_id, start, end],
    )
  ).rows[0];
  const baseline = Number(row.baseline);
  const known = Number(row.known);
  const rolled = Number(row.rolled);
  const unknown = baseline - known;
  return {
    rate: known ? (100 * rolled) / known : null,
    baseline,
    known,
    rolled,
    unknown,
    further: Number(row.further),
    start_date: start,
    end_date: end,
    lower_bound: baseline ? (100 * rolled) / baseline : null,
    upper_bound: baseline ? (100 * (rolled + unknown)) / baseline : null,
  };
}

function mondayCutoff(time: Date) {
  const today = todayIST(time);
  const weekday = new Date(today + 'T00:00:00Z').getUTCDay();
  let monday = shiftDay(today, -((weekday + 6) % 7));
  if (time < new Date(monday + 'T08:00:00+05:30'))
    monday = shiftDay(monday, -7);
  return monday;
}

async function freezeWeek(tx: Executor, user: User, start: string) {
  const end = shiftDay(start, 7);
  const cutoff = start + 'T08:00:00+05:30';
  await tx.query(
    [
      'INSERT INTO weekly_review_members(week_start,week_end,branch_id,officer_id,loan_id,score_id,base_rank,queue_count,baseline_dpd,baseline_overdue,synthetic)',
      'SELECT $2,$3,r.branch_id,r.officer_id,s.loan_id,s.id,s.base_rank,r.eligible_count,',
      "(s.input_facts->'ordering'->>2)::integer,(s.input_facts->'ordering'->>5)::numeric,false",
      'FROM (SELECT DISTINCT ON (officer_id) * FROM priority_runs WHERE branch_id=$1 AND work_date=$2 AND computed_at<=$4 AND policy_version=$5 ORDER BY officer_id,computed_at DESC,id DESC) r',
      'JOIN loan_priority_scores s ON s.run_id=r.id',
      "WHERE s.input_facts ? 'ordering' ON CONFLICT(week_start,loan_id) DO NOTHING",
    ].join(' '),
    [user.branch_id, start, end, cutoff, 'collections_queue_v1'],
  );
}

type ReviewGroup = {
  label: string;
  count: number;
  paid_count: number;
  amount: number;
};
type ReviewLoan = {
  external_loan_id: string;
  borrower_name: string;
  score: number;
  amount: number;
  paid: boolean;
  interventions: number;
  overrides: number;
};
type Week = {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  synthetic: boolean;
  status: string;
  groups: ReviewGroup[];
  loans: ReviewLoan[];
  officers_covered: number;
  officers_expected: number | null;
  revision?: number;
  recorded_at?: string;
};

function reviewWeeks(
  rows: Row[],
  time: Date,
  currentStart: string,
  activeOfficers: number,
) {
  const weeks = new Map<string, Week>();
  const make = (start: string, end: string, synthetic: boolean): Week => ({
    id: start,
    label: synthetic ? 'Historical demo week' : 'Week of ' + start,
    start_date: start,
    end_date: end,
    synthetic,
    status:
      time >= new Date(end + 'T08:00:00+05:30') ? 'completed' : 'in_progress',
    groups: ['Upper queue', 'Middle queue', 'Lower queue'].map((label) => ({
      label,
      count: 0,
      paid_count: 0,
      amount: 0,
    })),
    loans: [],
    officers_covered: 0,
    officers_expected:
      start === currentStart && !synthetic ? activeOfficers : null,
  });
  weeks.set(currentStart, make(currentStart, shiftDay(currentStart, 7), false));
  for (const row of rows) {
    const start = dateText(row.week_start);
    const synthetic = Boolean(row.synthetic);
    let week = weeks.get(start);
    if (!week || (week.loans.length === 0 && synthetic)) {
      week = make(start, dateText(row.week_end), synthetic);
      weeks.set(start, week);
    }
    const amount = Number(row.amount);
    const paid = amount > 0;
    const size = Math.max(1, Number(row.queue_count));
    const rank = Number(row.base_rank);
    const score =
      row.score == null
        ? Math.round((10000 * (size - rank + 1)) / size) / 100
        : Number(row.score);
    const group = week.groups[Math.min(2, Math.floor((3 * (rank - 1)) / size))];
    group.count++;
    group.paid_count += Number(paid);
    group.amount = Math.round((group.amount + amount) * 100) / 100;
    week.loans.push({
      external_loan_id: String(row.external_loan_id),
      borrower_name: String(row.borrower_name),
      score,
      amount,
      paid,
      interventions: Number(row.interventions),
      overrides: Number(row.overrides),
    });
  }
  for (const week of weeks.values()) {
    week.officers_covered = new Set(
      rows
        .filter((row) => dateText(row.week_start) === week.start_date)
        .map((row) => row.officer_id),
    ).size;
  }
  return [...weeks.values()].sort((a, b) =>
    b.start_date.localeCompare(a.start_date),
  );
}

async function recordCompletedReport(
  tx: Executor,
  branchId: string,
  week: Week,
  time: Date,
) {
  if (week.status !== 'completed') return week;
  const fingerprint = checksum(canonicalJson(week));
  const previous = (
    await tx.query(
      'SELECT revision,created_at FROM weekly_report_revisions WHERE branch_id=$1 AND week_start=$2 AND fingerprint=$3',
      [branchId, week.start_date, fingerprint],
    )
  ).rows[0];
  const saved =
    previous ??
    (
      await tx.query(
        'INSERT INTO weekly_report_revisions(branch_id,week_start,revision,fingerprint,report,created_at) SELECT $1,$2,COALESCE(MAX(revision),0)+1,$3,$4::jsonb,$5 FROM weekly_report_revisions WHERE branch_id=$1 AND week_start=$2 RETURNING revision,created_at',
        [
          branchId,
          week.start_date,
          fingerprint,
          JSON.stringify(week),
          time.toISOString(),
        ],
      )
    ).rows[0];
  return {
    ...week,
    revision: Number(saved.revision),
    recorded_at: instant(saved.created_at),
  };
}

export function reportingRoutes(now: () => Date) {
  const router = Router();
  router.get('/dashboard', managerOnly, async (_req, res) => {
    const user = currentUser(res);
    const time = now();
    const [loans, officers, rate, activityRows] = await Promise.all([
      portfolio(user, time, false),
      query(
        "SELECT id,full_name FROM users WHERE branch_id=$1 AND role='field_officer' AND is_active ORDER BY full_name",
        [user.branch_id],
      ),
      rollRate(user, todayIST(time)),
      query(
        'SELECT a.id,a.outcome,a.contact_method,a.notes,a.occurred_at,a.latitude,a.longitude,u.full_name AS officer_name,b.display_name AS borrower_name,l.external_loan_id FROM officer_activities a JOIN loans l ON l.id=a.loan_id JOIN borrowers b ON b.id=l.borrower_id JOIN users u ON u.id=a.officer_id WHERE l.branch_id=$1 ORDER BY a.occurred_at DESC,a.id LIMIT 15',
        [user.branch_id],
      ),
    ]);
    const active = loans.filter((l) => l.state !== 'cleared');
    const holds = ['review', 'stale', 'unassigned', 'scheduled', 'handled'].map(
      (state) => ({
        state,
        count: loans.filter((l) => l.state === state).length,
      }),
    );
    const conflictCount = (
      await query(
        "SELECT COUNT(*) AS count FROM promise_conflicts c JOIN loans l ON l.id=c.loan_id WHERE c.status='open' AND l.branch_id=$1",
        [user.branch_id],
      )
    ).rows[0];
    res.json({
      totals: {
        loans: loans.length,
        overdue_amount:
          Math.round(
            loans.reduce((sum, loan) => sum + loan.overdue_amount, 0) * 100,
          ) / 100,
        ready: loans.filter((loan) => loan.state === 'ready').length,
        broken_promises: active.filter(
          (loan) => loan.promise?.status === 'broken',
        ).length,
        unassigned: active.filter((loan) => !loan.assigned_officer_id).length,
        open_conflicts: Number(conflictCount.count),
      },
      officers: officers.rows.map((officer) => ({
        id: officer.id,
        full_name: officer.full_name,
        assigned: active.filter(
          (loan) => loan.assigned_officer_id === officer.id,
        ).length,
        ready: active.filter(
          (loan) =>
            loan.assigned_officer_id === officer.id && loan.state === 'ready',
        ).length,
      })),
      rollRate: rate,
      holds,
      activity: activityRows.rows.map((row) => ({
        ...row,
        occurred_at: instant(row.occurred_at),
      })),
    });
  });

  router.get('/weekly-review', managerOnly, async (_req, res) => {
    const user = currentUser(res);
    const weeks = await transaction(async (tx) => {
      await tx.query('SELECT id FROM branches WHERE id=$1 FOR UPDATE', [
        user.branch_id,
      ]);
      const time = now();
      const start = mondayCutoff(time);
      await freezeWeek(tx, user, start);
      const officers = (
        await tx.query(
          "SELECT COUNT(*) AS count FROM users WHERE branch_id=$1 AND is_active AND role='field_officer'",
          [user.branch_id],
        )
      ).rows[0];
      const rows = (
        await tx.query(
          [
            'SELECT w.*,l.external_loan_id,b.display_name AS borrower_name,s.score,',
            "COALESCE((SELECT SUM(m.amount) FROM mock_payments m WHERE m.loan_id=w.loan_id AND m.occurred_at>=((w.week_start+time '08:00') AT TIME ZONE 'Asia/Kolkata') AND m.occurred_at<((w.week_end+time '08:00') AT TIME ZONE 'Asia/Kolkata') AND m.received_at<=$2),0) AS amount,",
            "(SELECT COUNT(*) FROM officer_activities a WHERE a.loan_id=w.loan_id AND a.occurred_at>=((w.week_start+time '08:00') AT TIME ZONE 'Asia/Kolkata') AND a.occurred_at<((w.week_end+time '08:00') AT TIME ZONE 'Asia/Kolkata') AND a.received_at<=$2) AS interventions,",
            "(SELECT COUNT(*) FROM priority_override_history o WHERE o.loan_ids ? w.loan_id::text AND o.created_at>=((w.week_start+time '08:00') AT TIME ZONE 'Asia/Kolkata') AND o.created_at<((w.week_end+time '08:00') AT TIME ZONE 'Asia/Kolkata') AND o.created_at<=$2) AS overrides",
            'FROM weekly_review_members w JOIN loans l ON l.id=w.loan_id JOIN borrowers b ON b.id=l.borrower_id',
            'LEFT JOIN loan_priority_scores s ON s.id=w.score_id WHERE w.branch_id=$1 ORDER BY w.week_start DESC,w.officer_id,w.base_rank LIMIT 1000',
          ].join(' '),
          [user.branch_id, time.toISOString()],
        )
      ).rows;
      const reports = reviewWeeks(rows, time, start, Number(officers.count));
      const published = [];
      for (const report of reports)
        published.push(
          await recordCompletedReport(tx, user.branch_id, report, time),
        );
      return published;
    });
    res.json({ weeks });
  });

  router.post('/priority/override', managerOnly, async (req, res) => {
    const user = currentUser(res);
    const input = z
      .object({
        officer_id: id,
        loan_ids: z.array(id).min(1).max(500),
        reason: note,
      })
      .strict()
      .parse(req.body);
    const time = now();
    const loans = (await portfolio(user, time)).filter(
      (loan) =>
        loan.assigned_officer_id === input.officer_id && loan.rank != null,
    );
    if (
      input.loan_ids.length !== loans.length ||
      new Set(input.loan_ids).size !== input.loan_ids.length ||
      !loans.every((loan) => input.loan_ids.includes(loan.id))
    ) {
      throw new HttpError(
        409,
        'The ready queue changed. Refresh it and submit the complete current order.',
      );
    }
    const facts = Object.fromEntries(
      loans.map((loan) => [loan.id, orderingFact(loan)]),
    );
    await transaction(async (tx) => {
      const values = [
        input.officer_id,
        todayIST(time),
        user.id,
        JSON.stringify(input.loan_ids),
        JSON.stringify(facts),
        input.reason,
        time.toISOString(),
      ];
      await tx.query(
        'INSERT INTO priority_overrides(officer_id,work_date,manager_id,loan_ids,ordering_facts,reason,created_at) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7) ON CONFLICT(officer_id,work_date) DO UPDATE SET manager_id=excluded.manager_id,loan_ids=excluded.loan_ids,ordering_facts=excluded.ordering_facts,reason=excluded.reason,created_at=excluded.created_at',
        values,
      );
      await tx.query(
        'INSERT INTO priority_override_history(officer_id,work_date,manager_id,loan_ids,ordering_facts,reason,created_at) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)',
        values,
      );
    });
    res.json({ ok: true });
  });
  return router;
}
