import { describe, expect, it } from 'vitest';
import type { Loan } from '../shared/types';
import { contactAllowed, rankLoans, todayIST } from './policy';

const now = new Date('2026-11-09T05:00:00Z');
function loan(id: string, dpd: number, options: Partial<Loan> = {}): Loan {
  return {
    id,
    dpd,
    external_loan_id: id,
    borrower_id: id,
    branch_id: 'pune',
    assigned_officer_id: 'officer',
    borrower_name: id,
    phone_number: null,
    address: null,
    pincode: null,
    preferred_language: 'hi',
    outstanding_amount: 100000,
    overdue_amount: 1000,
    report_date: '2026-11-09',
    next_action_date: '2026-11-09',
    late_installments: 0,
    last_handled_date: null,
    hold_reason: null,
    promise: null,
    officer_name: 'Rahul',
    state: '',
    score: null,
    rank: null,
    reasons: [],
    group: 'early',
    version: 1,
    ...options,
  };
}

function broken(loan_id: string): NonNullable<Loan['promise']> {
  return {
    id: 'promise-' + loan_id,
    loan_id,
    promised_amount: 1000,
    due_date: '2026-11-08',
    status: 'broken',
    version: 1,
  };
}

describe('daily contact policy', () => {
  it('uses India calendar dates independently of the host timezone', () => {
    expect(todayIST(new Date('2026-11-08T20:00:00Z'))).toBe('2026-11-09');
  });
  it('allows 8 AM and blocks 7 PM exactly in India time', () => {
    expect(contactAllowed(new Date('2026-11-09T02:29:59Z'))).toBe(false);
    expect(contactAllowed(new Date('2026-11-09T02:30:00Z'))).toBe(true);
    expect(contactAllowed(new Date('2026-11-09T13:29:59Z'))).toBe(true);
    expect(contactAllowed(new Date('2026-11-09T13:30:00Z'))).toBe(false);
  });
});

describe('collection work ordering', () => {
  it('alternates equally due early and recovery loans before assigning relative scores', () => {
    const rows = rankLoans(
      [
        loan('A', 29, { promise: broken('A'), overdue_amount: 5000 }),
        loan('B', 29, { overdue_amount: 50000 }),
        loan('C', 15),
        loan('D', 60),
        loan('E', 35),
      ],
      'early',
      now,
    );
    expect(rows.map(({ id, score }) => [id, score])).toEqual([
      ['A', 100],
      ['D', 80],
      ['B', 60],
      ['E', 40],
      ['C', 20],
    ]);
  });
  it('carries older due work forward and respects the next recorded group', () => {
    const rows = rankLoans(
      [
        loan('A', 30),
        loan('B', 60),
        loan('C', 5, { next_action_date: '2026-11-08' }),
      ],
      'early',
      now,
    );
    expect(rows.map(({ id }) => id)).toEqual(['C', 'B', 'A']);
    expect(
      rankLoans([loan('A', 30), loan('B', 60)], 'recovery', now)[0].id,
    ).toBe('B');
  });
  it('keeps stale, held and scheduled cases visible without a current rank', () => {
    const future = { ...broken('F'), status: 'active', due_date: '2026-11-10' };
    const rows = rankLoans(
      [
        loan('S', 29, { report_date: '2026-11-08' }),
        loan('H', 50, { hold_reason: 'dispute' }),
        loan('F', 29, { promise: future }),
        loan('A', 31),
      ],
      'early',
      now,
    );
    expect(rows[0].id).toBe('A');
    expect(
      rows.slice(1).every((row) => row.rank === null && row.score === null),
    ).toBe(true);
  });
  it('skips incomplete history across the entire tied group', () => {
    const rows = [
      loan('A', 29, { late_installments: 3, overdue_amount: 1000 }),
      loan('B', 29, { late_installments: null, overdue_amount: 3000 }),
      loan('C', 29, { late_installments: 0, overdue_amount: 2000 }),
    ];
    expect(rankLoans(rows, 'early', now).map(({ id }) => id)).toEqual([
      'B',
      'C',
      'A',
    ]);
    expect(rankLoans(rows.reverse(), 'early', now).map(({ id }) => id)).toEqual(
      ['B', 'C', 'A'],
    );
  });
});
