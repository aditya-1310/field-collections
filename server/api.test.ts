import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { todayIST } from './policy';

process.env.DATABASE_PATH = 'memory://';
process.env.DATABASE_URL = '';

const today = todayIST();
const workingTime = new Date(today + 'T11:30:00+05:30');
const password = 'Demo@12345';
let manager: ReturnType<typeof request.agent>;
let officer: ReturnType<typeof request.agent>;
let beforeHours: ReturnType<typeof request.agent>;
let branchCode: string;
let sampleLoan: string;
let sampleOfficer: string;

beforeAll(async () => {
  const { migrate, seed } = await import('./db');
  await migrate();
  await seed();
  const { createApp } = await import('./index');
  manager = request.agent(createApp({ now: () => workingTime }));
  officer = request.agent(createApp({ now: () => workingTime }));
  beforeHours = request.agent(
    createApp({ now: () => new Date(today + 'T07:59:59+05:30') }),
  );
  await manager
    .post('/api/auth/login')
    .send({ email: 'manager@fieldnote.demo', password })
    .expect(200);
  const login = await officer
    .post('/api/auth/login')
    .send({ email: 'officer@fieldnote.demo', password })
    .expect(200);
  sampleOfficer = login.body.user.id;
  await beforeHours
    .post('/api/auth/login')
    .send({ email: 'officer@fieldnote.demo', password })
    .expect(200);
  const branches = await manager.get('/api/branches').expect(200);
  branchCode = branches.body.branches[0].code;
  const loans = await officer.get('/api/loans').expect(200);
  sampleLoan = loans.body.loans.find(
    (loan: { state: string }) => loan.state === 'ready',
  ).id;
});

describe('Access and CSV intake', () => {
  it('returns only public account fields and prevents an officer from importing', async () => {
    const { body } = await officer.get('/api/auth/me').expect(200);
    expect(body.user).toMatchObject({
      id: sampleOfficer,
      role: 'field_officer',
    });
    expect(body.user).not.toHaveProperty('password_hash');
    await officer
      .post('/api/imports')
      .send({ csv: 'invalid', report_date: today })
      .expect(403);
  });

  it('rejects a cross-site write even when the request contains a session', async () => {
    await manager
      .post('/api/imports')
      .set('Origin', 'https://other.invalid')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ csv: 'invalid', report_date: today })
      .expect(403);
  });

  it('rejects every loan in a file when one row is invalid', async () => {
    const headers =
      'loan_id,borrower_id,borrower_name,branch_code,pincode,phone,address,language,dpd,outstanding_amount,overdue_amount,late_installments';
    const valid = [
      'API-ATOMIC-1',
      'API-BORROWER-1',
      'Sample One',
      branchCode,
      '411001',
      '9000000001',
      'Pune',
      'en',
      12,
      5000,
      1000,
      1,
    ].join(',');
    const invalid = [
      'API-ATOMIC-2',
      'API-BORROWER-2',
      'Sample Two',
      branchCode,
      '411001',
      '9000000002',
      'Pune',
      'en',
      -5,
      5000,
      1000,
      1,
    ].join(',');
    await manager
      .post('/api/imports')
      .send({ csv: [headers, valid, invalid].join('\n'), report_date: today })
      .expect(400);
    const { body } = await manager.get('/api/loans').expect(200);
    expect(
      body.loans.some(
        (l: { external_loan_id: string }) =>
          l.external_loan_id === 'API-ATOMIC-1',
      ),
    ).toBe(false);
  });

  it('keeps an existing assignment on re-import', async () => {
    const initial = (await manager.get('/api/loans/' + sampleLoan).expect(200))
      .body.loan;
    const headers =
      'loan_id,borrower_id,borrower_name,branch_code,pincode,phone,address,language,dpd,outstanding_amount,overdue_amount,late_installments';
    const externalBorrowerId = initial.external_borrower_id;
    expect(externalBorrowerId).toBeTypeOf('string');
    const row = [
      initial.external_loan_id,
      externalBorrowerId,
      initial.borrower_name,
      branchCode,
      initial.pincode ?? '',
      initial.phone_number ?? '',
      initial.address ?? '',
      initial.preferred_language,
      initial.dpd,
      initial.outstanding_amount,
      initial.overdue_amount,
      initial.late_installments ?? '',
    ].map((v) => '"' + String(v).replaceAll('"', '""') + '"');
    await manager
      .post('/api/imports')
      .send({ csv: headers + '\n' + row.join(','), report_date: today })
      .expect(200);
    const after = (await manager.get('/api/loans/' + sampleLoan).expect(200))
      .body.loan;
    expect(after.assigned_officer_id).toBe(sampleOfficer);
    expect(after.next_action_date).toBe(initial.next_action_date);
  });
});

describe('Offline outcomes and contact guards', () => {
  it('records a blocked pre-opening contact and replays the same decision', async () => {
    const id = randomUUID();
    const payload = { id, method: 'call' };
    const first = await beforeHours
      .post('/api/loans/' + sampleLoan + '/contact')
      .send(payload)
      .expect(200);
    const replay = await beforeHours
      .post('/api/loans/' + sampleLoan + '/contact')
      .send(payload)
      .expect(200);
    expect(first.body).toMatchObject({ allowed: false });
    expect(replay.body).toEqual(first.body);
    const { body } = await manager.get('/api/loans/' + sampleLoan).expect(200);
    expect(
      body.contacts.filter((a: { id: string }) => a.id === id),
    ).toHaveLength(1);
  });

  it('stores an event once, preserves a conflicting promise, and resolves it explicitly', async () => {
    const first = {
      id: randomUUID(),
      loan_id: sampleLoan,
      outcome: 'promise_to_pay',
      contact_method: 'call',
      notes: 'First promise',
      occurred_at: workingTime.toISOString(),
      promised_amount: 500,
      due_date: today,
      base_promise_id: null as string | null,
      base_promise_version: null as number | null,
    };
    const { body: existing } = await officer
      .get('/api/loans/' + sampleLoan)
      .expect(200);
    const existingId = existing.loan.promise?.id ?? null;
    const existingVersion = existing.loan.promise?.version ?? null;
    first.base_promise_id = existingId;
    first.base_promise_version = existingVersion;

    const a = await officer
      .post('/api/sync')
      .send({ events: [first] })
      .expect(200);
    const replay = await officer
      .post('/api/sync')
      .send({ events: [first] })
      .expect(200);
    expect(a.body.results[0].status).toBe('applied');
    expect(replay.body).toEqual(a.body);
    const { body: after } = await officer
      .get('/api/loans/' + sampleLoan)
      .expect(200);
    expect(
      after.activities.filter(
        (activity: { notes: string }) => activity.notes === 'First promise',
      ),
    ).toHaveLength(1);

    const second = {
      ...first,
      id: randomUUID(),
      promised_amount: 400,
      notes: 'Offline proposal',
    };
    const b = await officer
      .post('/api/sync')
      .send({ events: [second] })
      .expect(200);
    expect(b.body.results[0].status).toBe('needs_review');
    const { body: conflicts } = await manager.get('/api/conflicts').expect(200);
    const conflict = conflicts.conflicts.find(
      (row: { loan_id: string }) => row.loan_id === sampleLoan,
    );
    expect(conflict.incoming.promised_amount).toBe(400);
    expect(conflict.current_promise.promised_amount).toBe(500);

    const resolve = {
      resolution: 'accept_incoming',
      note: 'Confirmed with officer',
      current_promise_id: conflict.current_promise_id,
      current_promise_version: conflict.current_promise_version,
    };
    await officer
      .post('/api/conflicts/' + conflict.id + '/resolve')
      .send(resolve)
      .expect(403);
    await manager
      .post('/api/conflicts/' + conflict.id + '/resolve')
      .send(resolve)
      .expect(200);
    const { body: final } = await officer
      .get('/api/loans/' + sampleLoan)
      .expect(200);
    expect(final.loan.promise.promised_amount).toBe(400);
    expect(
      final.activities.filter(
        (activity: { notes: string }) => activity.notes === 'Offline proposal',
      ),
    ).toHaveLength(1);
  });
});

type TestLoan = {
  id: string;
  external_loan_id: string;
  external_borrower_id: string;
  dpd: number;
  overdue_amount: number;
  state: string;
  rank: number;
  score: number;
  assigned_officer_id: string;
  phone_number: string;
};

const csvHeaders =
  'loan_id,borrower_id,borrower_name,branch_code,pincode,phone,address,language,dpd,outstanding_amount,overdue_amount,late_installments';

async function importCases(count = 1): Promise<TestLoan[]> {
  const key = randomUUID().slice(0, 8);
  const references = Array.from(
    { length: count },
    (_, i) => 'TEST-' + key + '-' + i,
  );
  const rows = references.map((ref, i) =>
    [
      ref,
      'TEST-B-' + key,
      'Synthetic test borrower',
      branchCode,
      '411001',
      '9000000001',
      'Pune',
      'en',
      28 + i,
      5000,
      1000,
      1,
    ].join(','),
  );
  await manager
    .post('/api/imports')
    .send({ csv: [csvHeaders, ...rows].join('\n'), report_date: today })
    .expect(200);
  const { body } = await manager.get('/api/loans').expect(200);
  const found = (body.loans as TestLoan[]).filter((loan) =>
    references.includes(loan.external_loan_id),
  );
  expect(found).toHaveLength(count);
  for (const loan of found) {
    await manager
      .post('/api/loans/' + loan.id + '/assign')
      .send({
        officer_id: sampleOfficer,
        reason: 'Integration test assignment',
      })
      .expect(200);
  }
  return found;
}

describe('Ownership and guarded actions', () => {
  it('blocks cross-branch reads, assignments and borrower reference claims', async () => {
    const { createApp } = await import('./index');
    const west = request.agent(createApp({ now: () => workingTime }));
    await west
      .post('/api/auth/login')
      .send({ email: 'west-manager@fieldnote.demo', password })
      .expect(200);
    await west.get('/api/loans/' + sampleLoan).expect(404);
    await west
      .post('/api/loans/' + sampleLoan + '/assign')
      .send({ officer_id: null, reason: 'Unrelated branch' })
      .expect(404);
    const branch = (await west.get('/api/branches').expect(200)).body
      .branches[0].code;
    const borrower = (await manager.get('/api/loans/' + sampleLoan).expect(200))
      .body.loan.external_borrower_id;
    const row = [
      'WEST-ILLEGAL-CLAIM',
      borrower,
      'Unrelated branch',
      branch,
      '',
      '',
      '',
      'en',
      3,
      1000,
      100,
      '',
    ].join(',');
    await west
      .post('/api/imports')
      .send({ csv: csvHeaders + '\n' + row, report_date: today })
      .expect(409);
    const { body } = await west.get('/api/loans').expect(200);
    expect(
      body.loans.some(
        (loan: TestLoan) => loan.external_loan_id === 'WEST-ILLEGAL-CLAIM',
      ),
    ).toBe(false);
  });

  it('consumes one borrower allowance across two loans with concurrent calls', async () => {
    const loans = await importCases(2);
    const outcomes = await Promise.all(
      loans.map((loan) =>
        officer
          .post('/api/loans/' + loan.id + '/contact')
          .send({ id: randomUUID(), method: 'call' })
          .expect(200),
      ),
    );
    expect(outcomes.filter((result) => result.body.allowed)).toHaveLength(1);
    expect(
      outcomes.filter((result) => !result.body.allowed)[0].body.reason,
    ).toMatch(/already recorded/i);
    for (const loan of loans) {
      const { body } = await manager.get('/api/loans/' + loan.id).expect(200);
      expect(body.contacts).toHaveLength(1);
      expect(body.loan.state).toBe('handled');
    }
  });

  it('holds sibling contact as soon as a conflicting offline visit arrives', async () => {
    const [primary, sibling] = await importCases(2);
    const first = {
      id: randomUUID(),
      loan_id: primary.id,
      outcome: 'promise_to_pay',
      contact_method: 'call',
      notes: 'Accepted call promise',
      occurred_at: workingTime.toISOString(),
      promised_amount: 500,
      due_date: today,
      base_promise_id: null,
      base_promise_version: null,
    };
    const a = await officer
      .post('/api/sync')
      .send({ events: [first] })
      .expect(200);
    expect(a.body.results[0].status).toBe('applied');
    const offlineVisit = {
      ...first,
      id: randomUUID(),
      contact_method: 'visit',
      promised_amount: 450,
    };
    const b = await officer
      .post('/api/sync')
      .send({ events: [offlineVisit] })
      .expect(200);
    expect(b.body.results[0].status).toBe('needs_review');
    const reply = await officer
      .post('/api/loans/' + sibling.id + '/contact')
      .send({ id: randomUUID(), method: 'call' })
      .expect(200);
    expect(reply.body).toMatchObject({ allowed: false });
    expect(reply.body.reason).toMatch(/already recorded/i);
  });

  it('requires approval of the current Hindi draft and replays a payment without double deduction', async () => {
    const [loan] = await importCases();
    const base = '/api/loans/' + loan.id;
    const before = (
      await officer.get(base + '/reminder?language=hi').expect(200)
    ).body;
    expect(before.message).toMatch(/नमस्ते/);
    const input = {
      id: randomUUID(),
      amount: 100,
      reference: 'TEST-RECEIPT-1',
    };
    const first = await manager
      .post(base + '/payment')
      .send(input)
      .expect(200);
    const retry = await manager
      .post(base + '/payment')
      .send(input)
      .expect(200);
    expect(retry.body.payment.id).toBe(first.body.payment.id);
    const { body: detail } = await officer.get(base).expect(200);
    expect(detail.loan.overdue_amount).toBe(900);
    expect(detail.loan.dpd).toBe(loan.dpd);
    expect(detail.payments).toHaveLength(1);
    const stale = await officer
      .post(base + '/contact')
      .send({
        id: randomUUID(),
        method: 'message',
        language: 'hi',
        draft_hash: before.draft_hash,
      })
      .expect(200);
    expect(stale.body.allowed).toBe(false);
    const current = (
      await officer.get(base + '/reminder?language=hi').expect(200)
    ).body;
    const sent = await officer
      .post(base + '/contact')
      .send({
        id: randomUUID(),
        method: 'message',
        language: 'hi',
        draft_hash: current.draft_hash,
      })
      .expect(200);
    expect(sent.body).toMatchObject({
      allowed: true,
      message: current.message,
    });
  });
});

describe('Branch reporting and overrides', () => {
  it('reports observed roll coverage and groups persisted baseline and payment records', async () => {
    const { body: overview } = await manager.get('/api/dashboard').expect(200);
    expect(overview.rollRate.baseline).toBeGreaterThan(0);
    expect(overview.rollRate.known + overview.rollRate.unknown).toBe(
      overview.rollRate.baseline,
    );
    expect(overview.rollRate.rate).toBeCloseTo(
      (100 * overview.rollRate.rolled) / overview.rollRate.known,
    );
    await officer.get('/api/weekly-review').expect(403);
    const { body } = await manager.get('/api/weekly-review').expect(200);
    const week = body.weeks.find(
      (entry: { synthetic: boolean }) => entry.synthetic,
    );
    expect(week.status).toBe('completed');
    expect(week.revision).toBe(1);
    expect(week.loans.length).toBeGreaterThan(0);
    expect(week.loans.some((loan: { amount: number }) => loan.amount > 0)).toBe(
      true,
    );
    expect(
      week.groups.reduce(
        (sum: number, group: { count: number }) => sum + group.count,
        0,
      ),
    ).toBe(week.loans.length);

    const { query } = await import('./db');
    const selected = week.loans[0];
    const managerUser = (await manager.get('/api/auth/me').expect(200)).body
      .user;
    const loan = (
      await query('SELECT id FROM loans WHERE external_loan_id=$1', [
        selected.external_loan_id,
      ])
    ).rows[0];
    await query(
      'INSERT INTO mock_payments(id,loan_id,confirmed_by_user_id,amount,reference,occurred_at,received_at) VALUES ($1,$2,$3,27.25,$4,$5,$6)',
      [
        randomUUID(),
        loan.id,
        managerUser.id,
        'RECONCILED-TEST',
        week.start_date + 'T10:00:00+05:30',
        workingTime.toISOString(),
      ],
    );
    const { body: revised } = await manager
      .get('/api/weekly-review')
      .expect(200);
    const updated = revised.weeks.find(
      (entry: { id: string }) => entry.id === week.id,
    );
    expect(updated.revision).toBe(2);
    expect(updated.loans[0].amount).toBeCloseTo(selected.amount + 27.25);
    const original = (
      await query(
        'SELECT report FROM weekly_report_revisions WHERE branch_id=$1 AND week_start=$2 AND revision=1',
        [managerUser.branch_id, week.start_date],
      )
    ).rows[0].report as { loans: { amount: number }[] };
    expect(original.loans[0].amount).toBe(selected.amount);
  });

  it('preserves base scores and inherits a manager order after removing a handled case', async () => {
    await importCases(2);
    const initial = (
      await officer.get('/api/loans').expect(200)
    ).body.loans.filter(
      (loan: TestLoan) => loan.state === 'ready',
    ) as TestLoan[];
    expect(initial.length).toBeGreaterThan(1);
    const ordered = [...initial].reverse();
    const payload = {
      officer_id: sampleOfficer,
      loan_ids: ordered.map((loan) => loan.id),
      reason: 'Integration test manual order',
    };
    await manager.post('/api/priority/override').send(payload).expect(200);
    const after = (
      await officer.get('/api/loans').expect(200)
    ).body.loans.filter(
      (loan: TestLoan) => loan.state === 'ready',
    ) as TestLoan[];
    expect(after.map((loan) => loan.id)).toEqual(payload.loan_ids);
    expect(after.map((loan) => loan.score)).toEqual(
      ordered.map((loan) => loan.score),
    );
    const target = after.find((loan) => loan.phone_number)!;
    const contact = await officer
      .post('/api/loans/' + target.id + '/contact')
      .send({ id: randomUUID(), method: 'call' })
      .expect(200);
    expect(contact.body.allowed).toBe(true);
    const next = (
      await officer.get('/api/loans').expect(200)
    ).body.loans.filter(
      (loan: TestLoan) => loan.state === 'ready',
    ) as TestLoan[];
    const surviving = new Set(next.map((loan) => loan.id));
    expect(next.map((loan) => loan.id)).toEqual(
      payload.loan_ids.filter((id) => surviving.has(id)),
    );
  });
});
