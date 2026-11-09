import { Router } from 'express';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { query, transaction } from './db';
import {
  canonicalJson,
  checksum,
  date,
  dateText,
  decodeJson,
  HttpError,
  id,
  instant,
  note,
} from './http';
import { scopedLoan, type Executor, type Row } from './portfolio';
import { todayIST } from './policy';
import { currentUser, managerOnly } from './routes';

const headers = [
  'loan_id',
  'borrower_id',
  'borrower_name',
  'branch_code',
  'pincode',
  'phone',
  'address',
  'language',
  'dpd',
  'outstanding_amount',
  'overdue_amount',
  'late_installments',
];
const ref = z.string().min(1).max(80);
const currency = z
  .string()
  .regex(
    /^\d{1,10}(\.\d{1,2})?$/,
    'Enter a non-negative amount with at most two decimal places.',
  )
  .transform(Number);
const optionalPincode = z
  .string()
  .regex(/^(\d{6})?$/, 'Use six digits for pincode.')
  .transform((s) => s || null);
const optionalPhone = z
  .string()
  .max(30)
  .transform((s) => s.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^(\+?\d{7,15})?$/, 'Use a valid phone number.'))
  .transform((s) => s || null);
const csvRow = z.object({
  loan_id: ref,
  borrower_id: ref,
  borrower_name: z.string().min(1).max(140),
  branch_code: ref,
  pincode: optionalPincode,
  phone: optionalPhone,
  address: z
    .string()
    .max(500)
    .transform((s) => s || null),
  language: z.enum(['hi', 'en', '']).transform((s) => s || 'hi'),
  dpd: z
    .string()
    .regex(/^\d{1,5}$/, 'Use whole non-negative days.')
    .transform(Number),
  outstanding_amount: currency,
  overdue_amount: currency,
  late_installments: z
    .string()
    .regex(/^[0-3]?$/, 'Enter a count from zero to three, or leave blank.')
    .transform((s) => (s === '' ? null : Number(s))),
});

function parseLoans(csv: string, branchCode: string) {
  let records: string[][];
  try {
    records = parse(csv, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      max_record_size: 65536,
    }) as string[][];
  } catch {
    throw new HttpError(
      400,
      'CSV format is invalid. Check quotations and column counts.',
    );
  }
  const columns = records.shift();
  if (
    !columns ||
    columns.length !== headers.length ||
    new Set(columns).size !== headers.length ||
    headers.some((field) => !columns.includes(field))
  ) {
    throw new HttpError(
      400,
      'Use the sample CSV headers. Keep optional columns even when their values are blank.',
    );
  }
  if (records.length === 0 || records.length > 1000)
    throw new HttpError(400, 'Upload between 1 and 1,000 loan rows.');
  const seen = new Set<string>();
  const borrowers = new Map<string, string>();
  return records.map((record, index) => {
    const parsed = csvRow.safeParse(
      Object.fromEntries(
        columns.map((column, columnIndex) => [
          column,
          record[columnIndex]?.trim(),
        ]),
      ),
    );
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(
        400,
        'Row ' +
          (index + 2) +
          ' (' +
          String(issue?.path[0] ?? 'unknown field') +
          '): ' +
          issue?.message,
      );
    }
    const row = parsed.data;
    if (row.branch_code !== branchCode)
      throw new HttpError(
        400,
        'Row ' + (index + 2) + ' does not belong to your branch.',
      );
    if (seen.has(row.loan_id))
      throw new HttpError(400, 'A loan appears more than once in the file.');
    if (
      row.overdue_amount > row.outstanding_amount ||
      (row.dpd === 0) !== (row.overdue_amount === 0)
    ) {
      throw new HttpError(
        400,
        'Row ' + (index + 2) + ' has inconsistent arrears, balance, or DPD.',
      );
    }
    seen.add(row.loan_id);
    const facts = canonicalJson([
      row.borrower_name,
      row.pincode,
      row.phone,
      row.address,
      row.language,
    ]);
    if (
      borrowers.has(row.borrower_id) &&
      borrowers.get(row.borrower_id) !== facts
    ) {
      throw new HttpError(400, 'Borrower details conflict within this file.');
    }
    borrowers.set(row.borrower_id, facts);
    return row;
  });
}

function importResult(batch: Row) {
  return {
    batch_id: String(batch.id),
    row_count: Number(batch.row_count),
    created: Number(batch.created_count),
    updated: Number(batch.updated_count),
  };
}

async function autoAssign(
  tx: Executor,
  branchId: string,
  pincode: string | null,
) {
  if (!pincode) return null;
  const row = (
    await tx.query(
      "SELECT u.id,COUNT(l.id) AS workload FROM users u JOIN officer_pincodes p ON p.officer_id=u.id AND p.pincode=$2 LEFT JOIN loans l ON l.assigned_officer_id=u.id AND l.overdue_amount>0 WHERE u.branch_id=$1 AND u.role='field_officer' AND u.is_active GROUP BY u.id ORDER BY workload,u.id LIMIT 1",
      [branchId, pincode],
    )
  ).rows[0];
  return row?.id ?? null;
}

export function importRoutes(now: () => Date) {
  const router = Router();
  router.get('/imports', managerOnly, async (_req, res) => {
    const rows = (
      await query(
        'SELECT id,report_date,status,row_count,created_at,created_count,updated_count,error_summary FROM import_batches WHERE branch_id=$1 ORDER BY created_at DESC,id LIMIT 100',
        [currentUser(res).branch_id],
      )
    ).rows;
    res.json({
      imports: rows.map((row) => ({
        id: row.id,
        report_date: dateText(row.report_date),
        status: row.status,
        row_count: Number(row.row_count ?? 0),
        created_at: instant(row.created_at),
        created: Number(row.created_count),
        updated: Number(row.updated_count),
        error: row.error_summary
          ? decodeJson<{ error: string }>(row.error_summary).error
          : null,
      })),
    });
  });

  router.post('/imports', managerOnly, async (req, res) => {
    const user = currentUser(res);
    const input = z
      .object({ csv: z.string().min(1).max(750000), report_date: date })
      .strict()
      .parse(req.body);
    const time = now();
    const today = todayIST(time);
    if (input.report_date > today)
      throw new HttpError(400, 'The report date cannot be in the future.');
    const hash = checksum(input.csv);
    try {
      const branch = (
        await query('SELECT code FROM branches WHERE id=$1', [user.branch_id])
      ).rows[0];
      if (!branch)
        throw new HttpError(
          403,
          'Your account is not assigned to a valid branch.',
        );
      const rows = parseLoans(input.csv, String(branch.code));
      const result = await transaction(async (tx) => {
        await tx.query('SELECT id FROM branches WHERE id=$1 FOR UPDATE', [
          user.branch_id,
        ]);
        const saved = (
          await tx.query(
            "SELECT * FROM import_batches WHERE branch_id=$1 AND report_date=$2 AND file_hash=$3 AND status='completed'",
            [user.branch_id, input.report_date, hash],
          )
        ).rows[0];
        if (saved) return importResult(saved);
        const batch = (
          await tx.query(
            "INSERT INTO import_batches(branch_id,uploaded_by_user_id,file_hash,report_date,status,row_count,created_at) VALUES ($1,$2,$3,$4,'processing',$5,$6) RETURNING id",
            [
              user.branch_id,
              user.id,
              hash,
              input.report_date,
              rows.length,
              time.toISOString(),
            ],
          )
        ).rows[0];
        let created = 0;
        let updated = 0;
        for (const row of rows) {
          const existing = (
            await tx.query(
              'SELECT l.*,b.external_borrower_id FROM loans l JOIN borrowers b ON b.id=l.borrower_id WHERE l.external_loan_id=$1 FOR UPDATE OF l',
              [row.loan_id],
            )
          ).rows[0];
          if (
            existing &&
            (existing.branch_id !== user.branch_id ||
              existing.external_borrower_id !== row.borrower_id)
          ) {
            throw new HttpError(
              409,
              'A loan reference conflicts with an existing branch or borrower.',
            );
          }
          const history = existing
            ? (
                await tx.query(
                  'SELECT dpd,outstanding_amount,overdue_amount FROM loan_daily_history WHERE loan_id=$1 AND report_date=$2',
                  [existing.id, input.report_date],
                )
              ).rows[0]
            : null;
          if (
            history &&
            (Number(history.dpd) !== row.dpd ||
              Number(history.outstanding_amount) !== row.outstanding_amount ||
              Number(history.overdue_amount) !== row.overdue_amount)
          ) {
            throw new HttpError(
              409,
              'This loan and report date already have a different accepted position. Use the correct report date.',
            );
          }

          // A borrower ID is shared across loans. Scope writes so one branch cannot edit another's contact record.
          const borrower =
            (
              await tx.query(
                'INSERT INTO borrowers(external_borrower_id,display_name,phone_number,address,pincode,preferred_language) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(external_borrower_id) DO NOTHING RETURNING id',
                [
                  row.borrower_id,
                  row.borrower_name,
                  row.phone,
                  row.address,
                  row.pincode,
                  row.language,
                ],
              )
            ).rows[0] ??
            (
              await tx.query(
                'SELECT id FROM borrowers WHERE external_borrower_id=$1',
                [row.borrower_id],
              )
            ).rows[0];
          await tx.query('SELECT id FROM borrowers WHERE id=$1 FOR UPDATE', [
            borrower.id,
          ]);
          if (
            !existing ||
            input.report_date >= dateText(existing.report_date)
          ) {
            const memberships = (
              await tx.query(
                'SELECT DISTINCT branch_id FROM loans WHERE borrower_id=$1',
                [borrower.id],
              )
            ).rows;
            const otherBranch = memberships.some(
              (membership) => membership.branch_id !== user.branch_id,
            );
            if (
              otherBranch &&
              !memberships.some(
                (membership) => membership.branch_id === user.branch_id,
              )
            ) {
              throw new HttpError(
                409,
                'A borrower reference conflicts with existing branch ownership.',
              );
            }
            if (!otherBranch) {
              await tx.query(
                'UPDATE borrowers SET display_name=$2,phone_number=$3,address=$4,pincode=$5,preferred_language=$6,updated_at=$7 WHERE id=$1',
                [
                  borrower.id,
                  row.borrower_name,
                  row.phone,
                  row.address,
                  row.pincode,
                  row.language,
                  time.toISOString(),
                ],
              );
            }
          }

          let loanId = existing?.id;
          if (!existing) {
            const officer =
              row.overdue_amount > 0
                ? await autoAssign(tx, user.branch_id, row.pincode)
                : null;
            loanId = (
              await tx.query(
                'INSERT INTO loans(external_loan_id,borrower_id,branch_id,assigned_officer_id,dpd,outstanding_amount,overdue_amount,report_date,next_action_date,late_installments,last_imported_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$11) RETURNING id',
                [
                  row.loan_id,
                  borrower.id,
                  user.branch_id,
                  officer,
                  row.dpd,
                  row.outstanding_amount,
                  row.overdue_amount,
                  input.report_date,
                  today,
                  row.late_installments,
                  time.toISOString(),
                ],
              )
            ).rows[0].id;
            if (officer) {
              await tx.query(
                "INSERT INTO loan_assignment_history(loan_id,to_officer_id,changed_by_user_id,method,reason,created_at) VALUES ($1,$2,$3,'auto_import','Matching pincode and lowest open workload',$4)",
                [loanId, officer, user.id, time.toISOString()],
              );
            }
            created++;
          } else if (
            input.report_date >= dateText(existing.report_date) &&
            !history
          ) {
            await tx.query(
              "UPDATE loans SET dpd=$2,outstanding_amount=$3,overdue_amount=$4::numeric,report_date=$5,late_installments=$6,last_imported_at=$7,updated_at=$7,hold_reason=CASE WHEN $4::numeric=0 AND hold_reason='Payment verification' THEN NULL ELSE hold_reason END,version=version+1 WHERE id=$1",
              [
                loanId,
                row.dpd,
                row.outstanding_amount,
                row.overdue_amount,
                input.report_date,
                row.late_installments,
                time.toISOString(),
              ],
            );
            updated++;
          }
          if (!history)
            await tx.query(
              'INSERT INTO loan_daily_history(loan_id,branch_id,import_batch_id,report_date,dpd,outstanding_amount,overdue_amount,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
              [
                loanId,
                user.branch_id,
                batch.id,
                input.report_date,
                row.dpd,
                row.outstanding_amount,
                row.overdue_amount,
                time.toISOString(),
              ],
            );
        }
        await tx.query(
          "UPDATE import_batches SET status='completed',created_count=$2,updated_count=$3,completed_at=$4 WHERE id=$1",
          [batch.id, created, updated, time.toISOString()],
        );
        return {
          batch_id: String(batch.id),
          row_count: rows.length,
          created,
          updated,
        };
      });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof HttpError
          ? error.message
          : 'The file could not be imported.';
      await query(
        "INSERT INTO import_batches(branch_id,uploaded_by_user_id,file_hash,report_date,status,error_summary,created_at,completed_at) VALUES ($1,$2,$3,$4,'failed',$5::jsonb,$6,$6)",
        [
          user.branch_id,
          user.id,
          hash,
          input.report_date,
          JSON.stringify({ error: message }),
          time.toISOString(),
        ],
      );
      throw error;
    }
  });

  router.post('/loans/:id/assign', managerOnly, async (req, res) => {
    const user = currentUser(res);
    const loanId = id.parse(req.params.id);
    const input = z
      .object({ officer_id: id.nullable(), reason: note })
      .strict()
      .parse(req.body);
    const time = now();
    await transaction(async (tx) => {
      const loan = await scopedLoan(tx, user, loanId, true);
      if (loan.assigned_officer_id === input.officer_id) return;
      if (input.officer_id) {
        const officer = (
          await tx.query(
            "SELECT id FROM users WHERE id=$1 AND branch_id=$2 AND is_active AND role='field_officer'",
            [input.officer_id, user.branch_id],
          )
        ).rows[0];
        if (!officer)
          throw new HttpError(
            400,
            'Choose an active field officer in your branch.',
          );
      }
      await tx.query(
        'UPDATE loans SET assigned_officer_id=$2,updated_at=$3,version=version+1 WHERE id=$1',
        [loanId, input.officer_id, time.toISOString()],
      );
      await tx.query(
        "INSERT INTO loan_assignment_history(loan_id,from_officer_id,to_officer_id,changed_by_user_id,method,reason,created_at) VALUES ($1,$2,$3,$4,'manager',$5,$6)",
        [
          loanId,
          loan.assigned_officer_id,
          input.officer_id,
          user.id,
          input.reason,
          time.toISOString(),
        ],
      );
      await tx.query(
        'DELETE FROM priority_overrides WHERE work_date=$1 AND (officer_id=$2 OR officer_id=$3)',
        [todayIST(time), loan.assigned_officer_id, input.officer_id],
      );
    });
    res.json({ ok: true });
  });
  return router;
}
