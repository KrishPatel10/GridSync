import { InjectionToken } from '@angular/core';
import { CellOp, RowOp } from './sync.models';

/**
 * A tab's unsent edits for one sheet, as last written to storage. `nodeId` exists only to keep
 * two tabs' records from overwriting each other: recovery never reuses it (see
 * pending-edits-outbox.ts), so nothing here depends on the writing tab still existing.
 *
 * Records written before rows could be inserted have no `rows`, and name a cell's row by number
 * (`row`) instead of by id (`rowId`); pending-edits-outbox.ts reads those too.
 */
export interface OutboxRecord {
  readonly sheetId: string;
  readonly nodeId: string;
  readonly ops: readonly CellOp[];
  /** Rows this tab inserted that the server has not yet acknowledged. */
  readonly rows?: readonly RowOp[];
  /** Date.now() as of the last write. How a stale (abandoned) record is told apart from a live one. */
  readonly lastSeenMs: number;
}

/** Where outbox records live. A thin interface so tests can use an in-memory fake instead of a real database. */
export interface OutboxStorage {
  getForSheet(sheetId: string): Promise<OutboxRecord[]>;
  put(record: OutboxRecord): Promise<void>;
  delete(sheetId: string, nodeId: string): Promise<void>;
}

const DB_NAME = 'gridsync-outbox';
const STORE = 'records';
const BY_SHEET_INDEX = 'bySheet';

/**
 * The real thing: one IndexedDB database, keyed by (sheetId, nodeId) so concurrent tabs on the
 * same sheet each own their own record. Hand-rolled promise wrapper around the callback-based
 * IndexedDB API; no library needed for three operations.
 */
export class IndexedDbOutboxStorage implements OutboxStorage {
  private dbPromise: Promise<IDBDatabase> | undefined;

  private openDb(): Promise<IDBDatabase> {
    return (this.dbPromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: ['sheetId', 'nodeId'] });
        store.createIndex(BY_SHEET_INDEX, 'sheetId');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  }

  async getForSheet(sheetId: string): Promise<OutboxRecord[]> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).index(BY_SHEET_INDEX).getAll(sheetId);
      request.onsuccess = () => resolve(request.result as OutboxRecord[]);
      request.onerror = () => reject(request.error);
    });
  }

  async put(record: OutboxRecord): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async delete(sheetId: string, nodeId: string): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete([sheetId, nodeId]);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

/**
 * A Map standing in for the database. Used as the test double, and as the runtime fallback when
 * IndexedDB is unavailable (private browsing in some browsers, a sandboxed iframe): the app keeps
 * working exactly as phase 1 did, with no durability across a closed tab, rather than crashing.
 */
export class InMemoryOutboxStorage implements OutboxStorage {
  private readonly records = new Map<string, OutboxRecord>();

  // ":" is safe: sheetId is restricted to [A-Za-z0-9_-] (see SHEET_ID in app.ts) and nodeId is hex.
  private static key(sheetId: string, nodeId: string): string {
    return `${sheetId}:${nodeId}`;
  }

  async getForSheet(sheetId: string): Promise<OutboxRecord[]> {
    return [...this.records.values()].filter((r) => r.sheetId === sheetId);
  }

  async put(record: OutboxRecord): Promise<void> {
    this.records.set(InMemoryOutboxStorage.key(record.sheetId, record.nodeId), record);
  }

  async delete(sheetId: string, nodeId: string): Promise<void> {
    this.records.delete(InMemoryOutboxStorage.key(sheetId, nodeId));
  }
}

/** True for the storage this app actually treats as durable across a closed tab. */
export function isDurable(storage: OutboxStorage): boolean {
  return storage instanceof IndexedDbOutboxStorage;
}

function createOutboxStorage(): OutboxStorage {
  return typeof indexedDB !== 'undefined' ? new IndexedDbOutboxStorage() : new InMemoryOutboxStorage();
}

/** Injectable so a test can supply its own storage, same pattern as FORMULA_BACKEND_FACTORY. */
export const OUTBOX_STORAGE_FACTORY = new InjectionToken<() => OutboxStorage>('OUTBOX_STORAGE_FACTORY', {
  providedIn: 'root',
  factory: () => createOutboxStorage,
});
