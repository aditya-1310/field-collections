import type { SyncEvent } from '../shared/types';
import type { OutboxEntry } from './offline';

export interface SyncResult {
  id: string;
  status: 'applied' | 'needs_review' | 'rejected';
  error?: string;
}

// The snapshot is fixed for this run. New device saves start another run afterward.
export async function uploadSnapshot(
  snapshot: OutboxEntry[],
  send: (events: SyncEvent[]) => Promise<{ results: SyncResult[] }>,
  saveReceipt: (entry: OutboxEntry) => Promise<void>,
): Promise<{ unacknowledged: number }> {
  const pending = [...snapshot];
  let acknowledged = 0;
  for (let offset = 0; offset < pending.length; offset += 50) {
    const batch = pending.slice(offset, offset + 50);
    const response = await send(batch.map((entry) => entry.event));
    const received = new Set<string>();
    for (const result of response.results) {
      const entry = batch.find((item) => item.id === result.id);
      if (
        !entry ||
        received.has(result.id) ||
        !['applied', 'needs_review', 'rejected'].includes(result.status)
      )
        continue;
      await saveReceipt({
        ...entry,
        status: result.status,
        error: result.error,
      });
      received.add(result.id);
    }
    acknowledged += received.size;
  }
  return { unacknowledged: pending.length - acknowledged };
}

export function importValidationError(
  csv: string,
  reportDate: string,
): string | null {
  if (csv.length > 750_000) return 'Use a CSV with at most 750,000 characters.';
  if (
    new TextEncoder().encode(JSON.stringify({ csv, report_date: reportDate }))
      .length > 1_000_000
  ) {
    return 'This CSV is too large to send. Use a smaller file so the request stays below 1 MB.';
  }
  return null;
}
