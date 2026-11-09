import { Router } from 'express';
import { z } from 'zod';
import type { SyncEvent, User } from '../shared/types';
import { query, transaction } from './db';
import {
  amount,
  canonicalJson,
  checksum,
  date,
  dateText,
  decodeJson,
  HttpError,
  id,
  instant,
  note,
  shiftDay,
} from './http';
import {
  currentPromise,
  scopedLoan,
  type Executor,
  type Row,
} from './portfolio';
import { contactAllowed, todayIST } from './policy';
import { currentUser, managerOnly, officerOnly } from './routes';

const eventSchema = z
  .object({
    id,
    loan_id: id,
    outcome: z.enum([
      'paid_reported',
      'promise_to_pay',
      'not_reachable',
      'dispute',
    ]),
    contact_method: z.enum(['call', 'visit']),
    notes: z.string().max(500),
    occurred_at: z.iso.datetime({ offset: true }),
    promised_amount: amount
      .refine((value) => value > 0, 'Enter a positive amount.')
      .optional(),
    due_date: date.optional(),
    base_promise_id: id.nullable(),
    base_promise_version: z.number().int().positive().nullable(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    location_accuracy_m: z.number().min(0).max(100000).optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (
      (event.latitude == null) !== (event.longitude == null) ||
      (event.location_accuracy_m != null && event.latitude == null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['latitude'],
        message: 'Provide both GPS coordinates together.',
      });
    }
    if (
      (event.base_promise_id == null) !==
      (event.base_promise_version == null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['base_promise_version'],
        message: 'Include the original promise ID and version together.',
      });
    }
    if (event.outcome === 'promise_to_pay') {
      if (
        event.promised_amount == null ||
        event.due_date == null ||
        event.due_date < todayIST(new Date(event.occurred_at))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['due_date'],
          message:
            'Include a positive amount and a due date on or after the interaction date.',
        });
      }
    }
  });

function assertPromiseVersion(
  current: { id: string; version: number } | null,
  expectedId: string | null,
  expectedVersion: number | null,
) {
  return (
    (current?.id ?? null) === expectedId &&
    (current?.version ?? null) === expectedVersion
  );
}

async function advanceTurn(
  tx: Executor,
  userId: unknown,
  day: string,
  dpd: number,
) {
  if (!userId) return;
  await tx.query(
    'INSERT INTO officer_queue_state(officer_id,work_date,next_group) VALUES ($1,$2,$3) ON CONFLICT(officer_id,work_date) DO UPDATE SET next_group=excluded.next_group',
    [userId, day, dpd <= 30 ? 'recovery' : 'early'],
  );
}

async function registerVisit(
  tx: Executor,
  userId: string,
  event: SyncEvent,
  loan: Row,
  time: Date,
) {
  if (event.contact_method !== 'visit') return;
  const eventDate = todayIST(new Date(event.occurred_at));
  await tx.query('SELECT id FROM borrowers WHERE id=$1 FOR UPDATE', [
    loan.borrower_id,
  ]);
  const allowance = (
    await tx.query(
      'INSERT INTO borrower_contacts(borrower_id,work_date,interaction_id) VALUES ($1,$2,$3) ON CONFLICT(borrower_id,work_date) DO NOTHING RETURNING interaction_id',
      [loan.borrower_id, eventDate, event.id],
    )
  ).rows[0];
  if (
    allowance &&
    eventDate === todayIST(time) &&
    loan.assigned_officer_id === userId
  ) {
    await advanceTurn(tx, userId, eventDate, Number(loan.dpd));
  }
}

async function saveActivity(
  tx: Executor,
  userId: string,
  event: SyncEvent,
  loan: Row,
  time: Date,
  apply: boolean,
) {
  const activity = (
    await tx.query(
      'INSERT INTO officer_activities(loan_id,officer_id,sync_event_id,contact_method,outcome,notes,occurred_at,received_at,latitude,longitude,location_accuracy_m) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(sync_event_id) DO NOTHING RETURNING id',
      [
        event.loan_id,
        userId,
        event.id,
        event.contact_method,
        event.outcome,
        event.notes.trim(),
        event.occurred_at,
        time.toISOString(),
        event.latitude ?? null,
        event.longitude ?? null,
        event.location_accuracy_m ?? null,
      ],
    )
  ).rows[0];
  if (!activity) return;

  const workDate = todayIST(time);
  const eventDate = todayIST(new Date(event.occurred_at));
  await registerVisit(tx, userId, event, loan, time);

  if (!apply) {
    if (eventDate === workDate && event.contact_method === 'visit') {
      await tx.query(
        'UPDATE loans SET last_handled_date=$2,next_action_date=GREATEST(next_action_date,$3),updated_at=$4,version=version+1 WHERE id=$1',
        [event.loan_id, eventDate, shiftDay(workDate, 1), time.toISOString()],
      );
    }
    return;
  }

  const tomorrow = shiftDay(workDate, 1);
  const previousSchedule = dateText(loan.next_action_date);
  let schedule: string | null =
    eventDate === workDate
      ? previousSchedule > tomorrow
        ? previousSchedule
        : tomorrow
      : null;
  let hold = loan.hold_reason;
  if (
    event.outcome === 'paid_reported' &&
    Number(loan.overdue_amount) > 0 &&
    !hold
  )
    hold = 'Payment verification';
  if (event.outcome === 'dispute') hold = 'Borrower dispute';
  if (event.outcome === 'promise_to_pay') {
    await tx.query(
      "UPDATE promises SET status='superseded',updated_at=$2,version=version+1 WHERE loan_id=$1 AND status='active'",
      [event.loan_id, time.toISOString()],
    );
    await tx.query(
      "INSERT INTO promises(loan_id,source_activity_id,promised_amount,due_date,status,version,created_at,updated_at) SELECT $1,$2,$3,$4,'active',COALESCE(MAX(version),0)+1,$5,$5 FROM promises WHERE loan_id=$1",
      [
        event.loan_id,
        activity.id,
        event.promised_amount,
        event.due_date,
        time.toISOString(),
      ],
    );
    // Do not rewind a newer schedule merely because an older activity synced late.
    if (
      eventDate === workDate ||
      (event.due_date && event.due_date >= dateText(loan.next_action_date))
    ) {
      schedule = event.due_date ?? null;
    }
  }
  await tx.query(
    'UPDATE loans SET hold_reason=$2,next_action_date=COALESCE($3::date,next_action_date),last_handled_date=GREATEST(last_handled_date,$4::date),updated_at=$5,version=version+1 WHERE id=$1',
    [event.loan_id, hold, schedule, eventDate, time.toISOString()],
  );
}

function eventReplay(previous: Row, user: User, event: SyncEvent) {
  if (
    previous.submitted_by_user_id !== user.id ||
    previous.loan_id !== event.loan_id ||
    canonicalJson(decodeJson(previous.payload)) !== canonicalJson(event)
  ) {
    throw new HttpError(
      409,
      'This event ID was already used for a different update.',
    );
  }
  return {
    id: event.id,
    status: previous.status === 'needs_review' ? 'needs_review' : 'applied',
  };
}

async function syncEvent(user: User, event: SyncEvent, time: Date) {
  if (new Date(event.occurred_at).getTime() > time.getTime() + 5 * 60000) {
    throw new HttpError(
      400,
      'This activity is dated in the future. Check the phone clock.',
    );
  }
  return transaction(async (tx) => {
    const previous = (
      await tx.query('SELECT * FROM sync_events WHERE id=$1', [event.id])
    ).rows[0];
    if (previous) return eventReplay(previous, user, event);
    const loan = await scopedLoan(tx, user, event.loan_id, true);
    const current = await currentPromise(tx, event.loan_id, todayIST(time));
    const conflict =
      event.outcome === 'promise_to_pay' &&
      !assertPromiseVersion(
        current,
        event.base_promise_id,
        event.base_promise_version,
      );
    const status = conflict ? 'needs_review' : 'applied';
    const stored = (
      await tx.query(
        'INSERT INTO sync_events(id,loan_id,submitted_by_user_id,payload,base_promise_id,base_promise_version,occurred_at,received_at,status) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING id',
        [
          event.id,
          event.loan_id,
          user.id,
          JSON.stringify(event),
          event.base_promise_id,
          event.base_promise_version,
          event.occurred_at,
          time.toISOString(),
          status,
        ],
      )
    ).rows[0];
    if (!stored) {
      const replay = (
        await tx.query('SELECT * FROM sync_events WHERE id=$1', [event.id])
      ).rows[0];
      return eventReplay(replay, user, event);
    }
    if (conflict) {
      await registerVisit(tx, user.id, event, loan, time);
      await tx.query(
        'INSERT INTO promise_conflicts(sync_event_id,loan_id,current_promise_id,current_promise_version,current_promise_snapshot,reason,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)',
        [
          event.id,
          event.loan_id,
          current?.id ?? null,
          current?.version ?? null,
          JSON.stringify(current),
          'The promise changed after the officer saved this update.',
          time.toISOString(),
        ],
      );
    } else {
      await saveActivity(tx, user.id, event, loan, time, true);
    }
    return { id: event.id, status };
  });
}

function draft(
  loan: Row,
  language: 'hi' | 'en',
  promise: { due_date: string; status: string } | null,
) {
  const amountText = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  }).format(Number(loan.overdue_amount));
  const due = promise?.status === 'active' ? promise.due_date : null;
  const message =
    language === 'hi'
      ? 'नमस्ते। आपके ऋण की बकाया राशि ₹' +
        amountText +
        ' है। ' +
        (due ? 'आपकी तय भुगतान तिथि ' + due + ' है। ' : '') +
        'यदि भुगतान हो चुका है, कृपया इस संदेश को अनदेखा करें। सहायता के लिए शाखा से संपर्क करें।'
      : 'Hello. Your overdue loan balance is ₹' +
        amountText +
        '. ' +
        (due ? 'Your agreed payment date is ' + due + '. ' : '') +
        'If you have already paid, please disregard this reminder. Contact your branch if you need help.';
  const template_id = 'repayment_reminder_v1_' + language;
  return {
    message,
    language,
    template_id,
    draft_hash: checksum(template_id + ':' + message),
  };
}

function containsProhibitedWording(message: string) {
  const normalized = message.normalize('NFKC').toLowerCase();
  return (
    /\b(arrest|police|jail|threaten|shame)\b/.test(normalized) ||
    ['गिरफ्तार', 'पुलिस', 'जेल', 'धमकी', 'बदनाम'].some((term) =>
      normalized.includes(term),
    )
  );
}

const contactBody = z
  .object({
    id,
    method: z.enum(['call', 'message']),
    language: z.enum(['hi', 'en']).optional(),
    draft_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

async function contactReplay(
  tx: Executor,
  input: z.infer<typeof contactBody>,
  user: User,
  loanId: string,
) {
  const replay = (
    await tx.query('SELECT * FROM contact_attempts WHERE id=$1', [input.id])
  ).rows[0];
  if (!replay) return null;
  if (
    replay.loan_id !== loanId ||
    replay.user_id !== user.id ||
    replay.method !== input.method ||
    (input.language && replay.language !== input.language) ||
    (replay.allowed &&
      replay.method === 'message' &&
      input.draft_hash !==
        checksum(
          'repayment_reminder_v1_' + replay.language + ':' + replay.message,
        ))
  ) {
    throw new HttpError(409, 'This contact ID was used for another request.');
  }
  return {
    allowed: replay.allowed,
    reason: replay.reason,
    message: replay.message,
  };
}

export function operationRoutes(now: () => Date) {
  const router = Router();
  router.post('/sync', officerOnly, async (req, res) => {
    const { events } = z
      .object({ events: z.array(z.unknown()).min(1).max(50) })
      .strict()
      .parse(req.body);
    const user = currentUser(res);
    const time = now();
    const results = [];
    for (const incoming of events) {
      const valid = eventSchema.safeParse(incoming);
      if (!valid.success) {
        const eventId =
          incoming && typeof incoming === 'object' && 'id' in incoming
            ? String(incoming.id).slice(0, 36)
            : '';
        results.push({
          id: eventId,
          status: 'rejected',
          error: valid.error.issues[0]?.message ?? 'Invalid activity.',
        });
        continue;
      }
      try {
        results.push(await syncEvent(user, valid.data, time));
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        results.push({
          id: valid.data.id,
          status: 'rejected',
          error: error.message,
        });
      }
    }
    res.json({ results });
  });

  router.get('/conflicts', managerOnly, async (_req, res) => {
    const user = currentUser(res);
    const day = todayIST(now());
    const rows = (
      await query(
        "SELECT c.*,s.payload,l.external_loan_id,b.display_name AS borrower_name,u.full_name AS officer_name FROM promise_conflicts c JOIN sync_events s ON s.id=c.sync_event_id JOIN loans l ON l.id=c.loan_id JOIN borrowers b ON b.id=l.borrower_id JOIN users u ON u.id=s.submitted_by_user_id WHERE l.branch_id=$1 AND c.status='open' ORDER BY c.created_at,c.id LIMIT 100",
        [user.branch_id],
      )
    ).rows;
    const conflicts = await Promise.all(
      rows.map(async (row) => {
        const live = await currentPromise({ query }, String(row.loan_id), day);
        return {
          id: row.id,
          loan_id: row.loan_id,
          external_loan_id: row.external_loan_id,
          borrower_name: row.borrower_name,
          officer_name: row.officer_name,
          created_at: instant(row.created_at),
          reason: row.reason,
          current_promise_id: live?.id ?? null,
          current_promise_version: live?.version ?? null,
          current_promise: live,
          detected_promise: row.current_promise_snapshot,
          incoming: decodeJson<SyncEvent>(row.payload),
        };
      }),
    );
    res.json({ conflicts });
  });

  router.post('/conflicts/:id/resolve', managerOnly, async (req, res) => {
    const user = currentUser(res);
    const conflictId = id.parse(req.params.id);
    const input = z
      .object({
        resolution: z.enum(['keep_current', 'accept_incoming']),
        note,
        current_promise_id: id.nullable(),
        current_promise_version: z.number().int().positive().nullable(),
      })
      .strict()
      .parse(req.body);
    const time = now();
    await transaction(async (tx) => {
      const found = (
        await tx.query(
          'SELECT c.loan_id FROM promise_conflicts c JOIN loans l ON l.id=c.loan_id WHERE c.id=$1 AND l.branch_id=$2',
          [conflictId, user.branch_id],
        )
      ).rows[0];
      if (!found)
        throw new HttpError(404, 'This review ticket is unavailable.');
      const loan = await scopedLoan(tx, user, String(found.loan_id), true);
      const conflict = (
        await tx.query(
          'SELECT * FROM promise_conflicts WHERE id=$1 FOR UPDATE',
          [conflictId],
        )
      ).rows[0];
      if (conflict.status !== 'open') {
        if (
          conflict.resolution === input.resolution &&
          conflict.resolution_note === input.note &&
          conflict.resolved_by_user_id === user.id
        )
          return;
        throw new HttpError(409, 'This review has already been resolved.');
      }
      const live = await currentPromise(tx, String(loan.id), todayIST(time));
      if (
        !assertPromiseVersion(
          live,
          input.current_promise_id,
          input.current_promise_version,
        )
      ) {
        throw new HttpError(
          409,
          'The current promise changed. Refresh the review before deciding.',
        );
      }
      const saved = (
        await tx.query('SELECT * FROM sync_events WHERE id=$1', [
          conflict.sync_event_id,
        ])
      ).rows[0];
      await saveActivity(
        tx,
        String(saved.submitted_by_user_id),
        decodeJson<SyncEvent>(saved.payload),
        loan,
        time,
        input.resolution === 'accept_incoming',
      );
      await tx.query(
        "UPDATE promise_conflicts SET status='resolved',resolution=$2,resolution_note=$3,resolved_by_user_id=$4,resolved_at=$5 WHERE id=$1",
        [conflictId, input.resolution, input.note, user.id, time.toISOString()],
      );
      await tx.query("UPDATE sync_events SET status='resolved' WHERE id=$1", [
        saved.id,
      ]);
    });
    res.json({ ok: true });
  });

  router.get('/loans/:id/reminder', officerOnly, async (req, res) => {
    const loan = await scopedLoan(
      { query },
      currentUser(res),
      id.parse(req.params.id),
    );
    const language = z
      .enum(['hi', 'en'])
      .parse(req.query.language ?? loan.preferred_language);
    const promise = await currentPromise(
      { query },
      String(loan.id),
      todayIST(now()),
    );
    const reminder = draft(loan, language, promise);
    if (containsProhibitedWording(reminder.message))
      throw new HttpError(422, 'The reminder did not pass the wording check.');
    res.json(reminder);
  });

  router.post('/loans/:id/contact', officerOnly, async (req, res) => {
    const user = currentUser(res);
    const loanId = id.parse(req.params.id);
    const input = contactBody.parse(req.body);
    const result = await transaction(async (tx) => {
      const saved = await contactReplay(tx, input, user, loanId);
      if (saved) return saved;
      const loan = await scopedLoan(tx, user, loanId, true);
      await tx.query('SELECT id FROM borrowers WHERE id=$1 FOR UPDATE', [
        loan.borrower_id,
      ]);
      const concurrentReplay = await contactReplay(tx, input, user, loanId);
      if (concurrentReplay) return concurrentReplay;
      const time = now();
      const day = todayIST(time);
      const language =
        input.language ?? (loan.preferred_language === 'hi' ? 'hi' : 'en');
      const promise = await currentPromise(tx, loanId, day);
      const reminder =
        input.method === 'message' ? draft(loan, language, promise) : null;
      const unresolved = (
        await tx.query(
          "SELECT 1 FROM promise_conflicts WHERE loan_id=$1 AND status='open' LIMIT 1",
          [loanId],
        )
      ).rows[0];
      let reason = '';
      if (!contactAllowed(time))
        reason = 'Contact is only allowed from 08:00 to 19:00 IST.';
      else if (!loan.phone_number)
        reason = 'No phone number is available for this borrower.';
      else if (loan.hold_reason || unresolved)
        reason = 'This case needs manager review before contact.';
      else if (dateText(loan.report_date) !== day)
        reason = 'Refresh the overdue report before contacting this borrower.';
      else if (Number(loan.dpd) <= 0 || Number(loan.overdue_amount) <= 0)
        reason = 'No overdue amount is currently actionable.';
      else if (
        dateText(loan.next_action_date) > day ||
        (promise?.status === 'active' && promise.due_date > day)
      )
        reason = 'This case is scheduled for a later date.';
      else if (reminder && containsProhibitedWording(reminder.message))
        reason = 'The reminder did not pass the wording check.';
      else if (reminder && reminder.draft_hash !== input.draft_hash)
        reason = 'The reminder must be approved again. Refresh the draft.';
      if (!reason) {
        const allowance = (
          await tx.query(
            'INSERT INTO borrower_contacts(borrower_id,work_date,interaction_id) VALUES ($1,$2,$3) ON CONFLICT(borrower_id,work_date) DO NOTHING RETURNING interaction_id',
            [loan.borrower_id, day, input.id],
          )
        ).rows[0];
        if (!allowance)
          reason =
            'A contact or visit is already recorded for this borrower today.';
      }
      const allowed = !reason;
      const message = allowed ? (reminder?.message ?? null) : null;
      const auditReason =
        reason ||
        (input.method === 'call'
          ? 'Mock call recorded.'
          : 'Mock reminder recorded.');
      const inserted = (
        await tx.query(
          'INSERT INTO contact_attempts(id,loan_id,borrower_id,user_id,method,allowed,reason,message,language,work_date,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING RETURNING id',
          [
            input.id,
            loanId,
            loan.borrower_id,
            user.id,
            input.method,
            allowed,
            auditReason,
            message,
            language,
            day,
            time.toISOString(),
          ],
        )
      ).rows[0];
      if (!inserted)
        throw new HttpError(
          409,
          'This contact ID was used for another request.',
        );
      if (allowed) {
        await tx.query(
          'UPDATE loans SET last_handled_date=$2,next_action_date=$3,updated_at=$4,version=version+1 WHERE id=$1',
          [loanId, day, shiftDay(day, 1), time.toISOString()],
        );
        await advanceTurn(tx, user.id, day, Number(loan.dpd));
      }
      return { allowed, reason: auditReason, message };
    });
    res.json(result);
  });

  router.post('/loans/:id/payment', managerOnly, async (req, res) => {
    const user = currentUser(res);
    const loanId = id.parse(req.params.id);
    const input = z
      .object({
        id,
        amount: amount.refine((value) => value > 0, 'Enter a positive amount.'),
        reference: z.string().trim().min(1).max(80),
      })
      .strict()
      .parse(req.body);
    const time = now();
    const day = todayIST(time);
    const payment = await transaction(async (tx) => {
      const loan = await scopedLoan(tx, user, loanId, true);
      const previous = (
        await tx.query(
          'SELECT id,loan_id,amount,reference,occurred_at FROM mock_payments WHERE id=$1 OR (loan_id=$2 AND reference=$3)',
          [input.id, loanId, input.reference],
        )
      ).rows;
      if (previous.length) {
        const row = previous[0];
        if (
          previous.length !== 1 ||
          row.loan_id !== loanId ||
          row.reference !== input.reference ||
          Number(row.amount) !== input.amount
        ) {
          throw new HttpError(
            409,
            'This payment ID or reference has already been used.',
          );
        }
        return row;
      }
      if (input.amount > Number(loan.outstanding_amount))
        throw new HttpError(
          400,
          'Payment cannot exceed the outstanding balance.',
        );
      const promise = await currentPromise(tx, loanId, day);
      const row = (
        await tx.query(
          'INSERT INTO mock_payments(id,loan_id,confirmed_by_user_id,promise_id,amount,reference,occurred_at,received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING RETURNING id,loan_id,amount,reference,occurred_at',
          [
            input.id,
            loanId,
            user.id,
            promise && ['active', 'broken'].includes(promise.status)
              ? promise.id
              : null,
            input.amount,
            input.reference,
            time.toISOString(),
          ],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(
          409,
          'This payment ID or reference has already been used.',
        );
      const arrears =
        Math.max(
          0,
          Math.round(Number(loan.overdue_amount) * 100) -
            Math.round(input.amount * 100),
        ) / 100;
      const balance =
        (Math.round(Number(loan.outstanding_amount) * 100) -
          Math.round(input.amount * 100)) /
        100;
      await tx.query(
        "UPDATE loans SET outstanding_amount=$2,overdue_amount=$3::numeric,dpd=CASE WHEN $3::numeric=0 THEN 0 ELSE dpd END,report_date=CASE WHEN $3::numeric=0 THEN GREATEST(report_date,$4::date) ELSE report_date END,hold_reason=CASE WHEN hold_reason='Payment verification' THEN NULL ELSE hold_reason END,updated_at=$5,version=version+1 WHERE id=$1",
        [loanId, balance, arrears, day, time.toISOString()],
      );
      if (promise?.status === 'active') {
        const after = await currentPromise(tx, loanId, day);
        if (after?.status === 'kept') {
          await tx.query(
            "UPDATE promises SET status='kept',version=version+1,updated_at=$2 WHERE id=$1",
            [after.id, time.toISOString()],
          );
        } else {
          await tx.query(
            'UPDATE promises SET version=version+1,updated_at=$2 WHERE id=$1',
            [promise.id, time.toISOString()],
          );
        }
      }
      return row;
    });
    res.json({
      ok: true,
      payment: {
        ...payment,
        amount: Number(payment.amount),
        occurred_at: instant(payment.occurred_at),
      },
    });
  });
  return router;
}
