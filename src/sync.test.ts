import { describe, expect, it } from 'vitest';
import type { OutboxEntry } from './offline';
import { importValidationError, uploadSnapshot } from './sync';

const entry = (index: number): OutboxEntry => ({
  id: `event-${index}`,
  user_id: 'officer-1',
  borrower_name: 'Demo borrower',
  status: 'pending',
  event: {
    id: `event-${index}`,
    loan_id: `loan-${index}`,
    outcome: 'not_reachable',
    contact_method: 'visit',
    notes: '',
    occurred_at: '2026-11-09T10:00:00Z',
    base_promise_id: null,
    base_promise_version: null,
  },
});
describe('device outbox upload', () => {
  it('uploads more than fifty pending entries in bounded batches using the original event IDs', async () => {
    const snapshot = Array.from({ length: 121 }, (_, i) => entry(i));
    const batches: number[] = [];
    const saved: OutboxEntry[] = [];
    const result = await uploadSnapshot(
      snapshot,
      async (events) => {
        batches.push(events.length);
        return {
          results: events.map((event) => ({
            id: event.id,
            status: 'applied' as const,
          })),
        };
      },
      async (item) => {
        saved.push(item);
      },
    );
    expect(batches).toEqual([50, 50, 21]);
    expect(saved.map((item) => item.id)).toEqual(
      snapshot.map((item) => item.id),
    );
    expect(result.unacknowledged).toBe(0);
  });
  it('keeps prior receipts and leaves unsent entries untouched if a later batch fails', async () => {
    const snapshot = Array.from({ length: 75 }, (_, i) => entry(i));
    const saved: OutboxEntry[] = [];
    let calls = 0;
    await expect(
      uploadSnapshot(
        snapshot,
        async (events) => {
          calls += 1;
          if (calls === 2) throw new Error('Connection lost');
          return {
            results: events.map((event) => ({
              id: event.id,
              status: 'applied' as const,
            })),
          };
        },
        async (item) => {
          saved.push(item);
        },
      ),
    ).rejects.toThrow('Connection lost');
    expect(saved).toHaveLength(50);
    expect(snapshot.slice(50).every((item) => item.status === 'pending')).toBe(
      true,
    );
  });
  it('keeps missing receipts pending and does not accept IDs from another batch', async () => {
    const saved: OutboxEntry[] = [];
    const result = await uploadSnapshot(
      [entry(1), entry(2), entry(3)],
      async () => ({
        results: [
          { id: 'event-1', status: 'needs_review' },
          { id: 'event-2', status: 'rejected', error: 'Assignment changed' },
          { id: 'another-user-event', status: 'applied' },
        ],
      }),
      async (item) => {
        saved.push(item);
      },
    );
    expect(saved.map((item) => item.status)).toEqual([
      'needs_review',
      'rejected',
    ]);
    expect(result.unacknowledged).toBe(1);
  });
  it('finishes its stable snapshot and leaves updates saved during upload for the next run', async () => {
    const snapshot = [entry(1)];
    const saved: OutboxEntry[] = [];
    await uploadSnapshot(
      snapshot,
      async (events) => {
        snapshot.push(entry(2));
        return {
          results: events.map((event) => ({
            id: event.id,
            status: 'applied' as const,
          })),
        };
      },
      async (item) => {
        saved.push(item);
      },
    );
    expect(saved.map((item) => item.id)).toEqual(['event-1']);
    expect(snapshot[1].status).toBe('pending');
  });
});
describe('CSV request size', () => {
  it('checks the backend character cap and UTF-8 JSON request size independently', () => {
    expect(importValidationError('a'.repeat(750_001), '2026-11-09')).toContain(
      '750,000',
    );
    expect(importValidationError('ह'.repeat(400_000), '2026-11-09')).toContain(
      '1 MB',
    );
    expect(
      importValidationError(
        'loan_id,borrower_id\nDEMO-1,DEMO-B1',
        '2026-11-09',
      ),
    ).toBeNull();
  });
});
