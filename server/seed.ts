import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { closeDb, getDb, type Database } from './db';
import { addDays, POLICY_VERSION, rankLoans, todayIST } from './policy';
import type { Loan } from '../shared/types';

const demoPassword = 'Demo@12345';

export async function seedDatabase(db: Database, now = new Date()) {
  const today = todayIST(now);
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  const hash = await bcrypt.hash(demoPassword, 10);
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(71924014)');
    if ((await tx.query('SELECT id FROM users LIMIT 1')).rows.length) return;

    const branch = randomUUID();
    const west = randomUUID();
    const manager = randomUUID();
    const rahul = randomUUID();
    const neha = randomUUID();
    const imran = randomUUID();
    const westManager = randomUUID();
    const westOfficer = randomUUID();
    await tx.query('INSERT INTO branches(id,code,name) VALUES($1,$2,$3),($4,$5,$6)',
      [branch, 'IND-C', 'Indore Central', west, 'IND-W', 'Indore West']);

    const staff = [
      [manager, branch, 'Asha Mehta', 'manager@fieldnote.demo', 'branch_manager'],
      [rahul, branch, 'Rahul Chouhan', 'officer@fieldnote.demo', 'field_officer'],
      [neha, branch, 'Neha Solanki', 'neha@fieldnote.demo', 'field_officer'],
      [imran, branch, 'Imran Qureshi', 'imran@fieldnote.demo', 'field_officer'],
      [westManager, west, 'Kiran Patel', 'west-manager@fieldnote.demo', 'branch_manager'],
      [westOfficer, west, 'Dev Rao', 'west-officer@fieldnote.demo', 'field_officer'],
    ];
    for (const member of staff) {
      await tx.query('INSERT INTO users(id,branch_id,full_name,email,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)', [...member, hash]);
    }
    for (const [officer, pincode] of [[rahul, '452001'], [neha, '452001'], [neha, '452010'], [imran, '452003'], [westOfficer, '452009']]) {
      await tx.query('INSERT INTO officer_pincodes(officer_id,pincode) VALUES($1,$2)', [officer, pincode]);
    }

    // The first three rows preserve the brief's example loan IDs, names, balances, and DPD.
    const cases = [
      { ref: 'LN-10293', borrower: 'Company B (packaging unit)', total: 640000, due: 32000, dpd: 12, officer: rahul, pin: '452001', late: 1, promised: '2026-11-05' },
      { ref: 'LN-10871', borrower: 'Company C (fertiliser shop)', total: 310000, due: 15500, dpd: 27, officer: neha, pin: '452010', late: 0 },
      { ref: 'LN-11930', borrower: 'Company D (printing press)', total: 220000, due: 11000, dpd: 19, officer: imran, pin: '452003', late: 2, promised: '2026-10-31' },
      { ref: 'LN-12021', borrower: 'Pragati Tools', total: 260000, due: 5000, dpd: 29, officer: rahul, pin: '452001', late: 2, promised: yesterday },
      { ref: 'LN-12022', borrower: 'Sundar Textiles', total: 650000, due: 50000, dpd: 29, officer: rahul, pin: '452001', late: 3 },
      { ref: 'LN-12023', borrower: 'Narmada Metalworks', total: 740000, due: 80000, dpd: 15, officer: rahul, pin: '452001', late: 3, promised: yesterday },
      { ref: 'LN-12024', borrower: 'Aarav Fabrication', total: 420000, due: 10000, dpd: 60, officer: rahul, pin: '452001', late: 1, promised: yesterday },
      { ref: 'LN-12025', borrower: 'Ujjwal Paper Traders', total: 280000, due: 20000, dpd: 35, officer: rahul, pin: '452001', late: 2 },
      { ref: 'LN-12026', borrower: 'Avani Food Works', total: 195000, due: 8300, dpd: 18, officer: rahul, pin: '452001', late: 0, promised: tomorrow },
      { ref: 'LN-12027', borrower: 'Meera Electricals', total: 345000, due: 18000, dpd: 25, officer: neha, pin: '452010', late: null, hold: 'dispute' },
      { ref: 'LN-12028', borrower: 'Malwa Components', total: 480000, due: 28000, dpd: 34, officer: westOfficer, pin: '452009', late: 1 },
    ];

    const date = new Date(today + 'T00:00:00Z');
    let weekEnd = addDays(today, -((date.getUTCDay() + 6) % 7));
    if (now < new Date(weekEnd + 'T08:00:00+05:30')) weekEnd = addDays(weekEnd, -7);
    const weekStart = addDays(weekEnd, -7);
    const baselineTime = new Date(weekStart + 'T08:00:00+05:30');
    const historicLoans: Loan[] = [];

    for (const [index, row] of cases.entries()) {
      const loanId = randomUUID();
      const borrowerId = randomUUID();
      const branchId = row.officer === westOfficer ? west : branch;
      const managerId = branchId === west ? westManager : manager;
      const phone = '+9100000000' + String(index + 1).padStart(2, '0');
      const address = `Demo industrial sector ${index + 1}, Indore ${row.pin}`;
      const language = index % 3 === 0 ? 'en' : 'hi';
      await tx.query(`INSERT INTO borrowers(id,external_borrower_id,display_name,phone_number,address,pincode,preferred_language)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [borrowerId, 'BOR-' + (index + 1), row.borrower, phone, address, row.pin, language]);
      const nextDate = row.promised && row.promised > today ? row.promised : today;
      await tx.query(`INSERT INTO loans(id,external_loan_id,borrower_id,branch_id,assigned_officer_id,dpd,outstanding_amount,overdue_amount,report_date,next_action_date,late_installments,hold_reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [loanId, row.ref, borrowerId, branchId, row.officer, row.dpd, row.total, row.due, today, nextDate, row.late, row.hold ?? null]);
      await tx.query(`INSERT INTO loan_assignment_history(loan_id,to_officer_id,changed_by_user_id,method,reason)
        VALUES($1,$2,$3,'seed','Demo assignment')`, [loanId, row.officer, managerId]);

      if (row.promised) {
        const activityId = randomUUID();
        const activityAt = addDays(row.promised, -1) + 'T11:00:00+05:30';
        await tx.query(`INSERT INTO officer_activities(id,loan_id,officer_id,contact_method,outcome,notes,occurred_at,latitude,longitude,location_accuracy_m)
          VALUES($1,$2,$3,'visit','promise_to_pay','Synthetic visit from demo data',$4,22.7196,75.8577,25)`,
          [activityId, loanId, row.officer, activityAt]);
        await tx.query(`INSERT INTO promises(loan_id,source_activity_id,promised_amount,due_date,status,created_at)
          VALUES($1,$2,$3,$4,$5,$6)`, [loanId, activityId, Math.min(row.due, 5000), row.promised,
          row.promised < today ? 'broken' : 'active', activityAt]);
      }

      const baselineDpd = Math.max(1, row.dpd - 7);
      const history = new Map([[weekStart, baselineDpd], [weekEnd, row.dpd], [today, row.dpd]]);
      for (const [reportDate, dpd] of history) {
        await tx.query(`INSERT INTO loan_daily_history(loan_id,branch_id,report_date,dpd,outstanding_amount,overdue_amount)
          VALUES($1,$2,$3,$4,$5,$6)`, [loanId, branchId, reportDate, dpd, row.total, row.due]);
      }

      historicLoans.push({
        id: loanId, external_loan_id: row.ref, borrower_id: borrowerId, branch_id: branchId,
        assigned_officer_id: row.officer, borrower_name: row.borrower, phone_number: phone,
        address, pincode: row.pin, preferred_language: language, dpd: baselineDpd,
        outstanding_amount: row.total, overdue_amount: row.due, report_date: weekStart,
        next_action_date: weekStart, late_installments: row.late, last_handled_date: null,
        hold_reason: null, promise: null, officer_name: null, state: '', score: null, rank: null,
        reasons: [], group: baselineDpd <= 30 ? 'early' : 'recovery', version: 1,
      });
    }

    for (const officer of [rahul, neha, imran, westOfficer]) {
      const queue = rankLoans(historicLoans.filter((loan) => loan.assigned_officer_id === officer), 'early', baselineTime);
      const branchId = queue[0].branch_id;
      const runId = randomUUID();
      await tx.query(`INSERT INTO priority_runs(id,officer_id,branch_id,work_date,policy_version,fingerprint,eligible_count,computed_at)
        VALUES($1,$2,$3,$4,$5,'synthetic-baseline',$6,$7)`, [runId, officer, branchId, weekStart, POLICY_VERSION, queue.length, baselineTime]);
      for (const loan of queue) {
        const scoreId = randomUUID();
        await tx.query(`INSERT INTO loan_priority_scores(id,run_id,loan_id,base_rank,score,reasons,input_facts)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`, [scoreId, runId, loan.id, loan.rank, loan.score,
          JSON.stringify(loan.reasons), JSON.stringify({ dpd: loan.dpd, overdue_amount: loan.overdue_amount, report_date: weekStart })]);
        await tx.query(`INSERT INTO weekly_review_members(week_start,week_end,branch_id,officer_id,loan_id,score_id,base_rank,queue_count,baseline_dpd,baseline_overdue,synthetic)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`, [weekStart, weekEnd, branchId, officer, loan.id, scoreId,
          loan.rank, queue.length, loan.dpd, loan.overdue_amount]);
        if (loan.rank && loan.rank % 2 === 1) {
          const at = addDays(weekStart, 3) + 'T12:00:00+05:30';
          await tx.query(`INSERT INTO mock_payments(id,loan_id,confirmed_by_user_id,amount,reference,occurred_at,received_at)
            VALUES($1,$2,$3,$4,$5,$6,$6)`, [randomUUID(), loan.id, branchId === west ? westManager : manager,
            Math.round(loan.overdue_amount * 0.25), 'SYNTHETIC-' + loan.external_loan_id, at]);
        }
      }
    }
  });
}

export const seed = () => seedDatabase(getDb());

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const db = getDb();
  try {
    await db.migrate();
    await seedDatabase(db);
    console.log('Demo dataset is ready.');
  } catch (error) {
    console.error('Demo setup failed.', { code: (error as { code?: string }).code, name: (error as Error).name });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
