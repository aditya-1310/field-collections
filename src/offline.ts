import { openDB, type DBSchema } from 'idb';
import type { Loan, SyncEvent, User } from '../shared/types';

export interface OutboxEntry {
  id: string;
  user_id: string;
  borrower_name: string;
  event: SyncEvent;
  status: 'pending' | 'applied' | 'needs_review' | 'rejected';
  error?: string;
}
interface FieldnoteDB extends DBSchema {
  identity: { key: string; value: User };
  cases: {
    key: string;
    value: { user_id: string; loans: Loan[]; saved_at: string };
  };
  outbox: { key: string; value: OutboxEntry; indexes: { 'by-user': string } };
}
const database = () =>
  openDB<FieldnoteDB>('fieldnote-device-v1', 1, {
    upgrade(db) {
      db.createObjectStore('identity');
      db.createObjectStore('cases', { keyPath: 'user_id' });
      db.createObjectStore('outbox', { keyPath: 'id' }).createIndex(
        'by-user',
        'user_id',
      );
    },
  });
export async function savedIdentity() {
  return (await database()).get('identity', 'last-user');
}
export async function rememberIdentity(user: User) {
  await (await database()).put('identity', user, 'last-user');
}
export async function cachedCases(userId: string) {
  return (await database()).get('cases', userId);
}
export async function cacheCases(userId: string, loans: Loan[]) {
  await (
    await database()
  ).put('cases', {
    user_id: userId,
    loans,
    saved_at: new Date().toISOString(),
  });
}
export async function entries(userId: string) {
  return (await database()).getAllFromIndex('outbox', 'by-user', userId);
}
export async function putEntry(entry: OutboxEntry) {
  await (await database()).put('outbox', entry);
}
export async function clearUser(userId: string) {
  const db = await database();
  const tx = db.transaction(['identity', 'cases', 'outbox'], 'readwrite');
  await tx.objectStore('identity').delete('last-user');
  await tx.objectStore('cases').delete(userId);
  const keys = await tx
    .objectStore('outbox')
    .index('by-user')
    .getAllKeys(userId);
  await Promise.all(keys.map((key) => tx.objectStore('outbox').delete(key)));
  await tx.done;
}
