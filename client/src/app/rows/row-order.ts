import { between, compareKeys, forBaseRow } from './fractional-index';

/** A row someone inserted: a random id and the key that says where it sorts. Mirrors GridSync.Core.RowOp. */
export interface InsertedRow {
  readonly rowId: string;
  readonly key: string;
}

const BASE_ID = /^b(0|[1-9]\d{0,8})$/;

/** The id of one of the rows a sheet starts with: "b0", "b1", and so on. Mirrors RowIds.ForBaseRow in C#. */
export function baseRowId(index: number): string {
  return `b${index}`;
}

/** The number in a base row id, or null if this is not one. */
export function parseBaseRowId(rowId: string): number | null {
  return BASE_ID.test(rowId) ? Number(rowId.substring(1)) : null;
}

/** A fresh id for an inserted row: 32 lowercase hex digits. Mirrors RowIds.IsInsertedId in C#. */
export function newRowId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Entry {
  readonly id: string;
  readonly key: string;
  /** This row's handle: a small number, private to this replica, that names the row in cell storage. */
  readonly handle: number;
  /** How many of the sheet's initial rows sort before this one. Fixed for good once the row exists. */
  readonly baseBefore: number;
}

/** Rows compare by key, then by id, so two rows given the same key by concurrent inserts still have one agreed order. */
function compareRows(keyA: string, idA: string, keyB: string, idB: string): number {
  return compareKeys(keyA, keyB) || compareKeys(idA, idB);
}

/** What a snapshot of the order can answer. Also what a formula result needs to find its cell after rows have moved. */
export interface RowLayout {
  readonly count: number;
  /** The handle of the row at this position, or -1 if there is none. */
  handleAt(index: number): number;
  /** Where this handle is now, or -1 if it is not a row here. */
  indexOfHandle(handle: number): number;
}

/**
 * The order of a sheet's rows, and the numbers to name them by.
 *
 * A sheet starts with `baseRows` implicit rows and grows as rows are inserted. Every row sorts by
 * (key, id). The initial rows' keys are computed from their number, so 100,000 of them cost nothing
 * to hold; only inserted rows are stored, in a sorted array. Because the order is a pure function
 * of the set of rows, two replicas that have seen the same rows agree on it, whatever order the
 * rows arrived in: that is the convergence property, and it is why insert() needs no coordination.
 *
 * Finding the row at a position is arithmetic, not a scan. An inserted row's position is its place
 * among the inserted rows plus the count of initial rows that sort before it (`baseBefore`, worked
 * out once, by binary search, when the row arrives). Those positions strictly increase, so "who is
 * at position p?" is one binary search: how many inserted rows sit before p? If the next one is
 * exactly at p, that is the row; otherwise p is an initial row, number p minus that count.
 *
 * Handles: an initial row's handle is its number, so cell storage for an untouched sheet looks the
 * way it always did. An inserted row's handle is `baseRows` plus the order this replica first heard
 * of it. Handles are local, never sent anywhere, and never change.
 */
export class RowOrder implements RowLayout {
  private sorted: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  private readonly byHandle: Entry[] = [];
  private cachedLayout: RowOrder | null = null;

  constructor(readonly baseRows: number) {}

  get count(): number {
    return this.baseRows + this.sorted.length;
  }

  get insertedCount(): number {
    return this.sorted.length;
  }

  /** The inserted rows, in row order. For saving to the outbox and for tests. */
  inserted(): InsertedRow[] {
    return this.sorted.map((e) => ({ rowId: e.id, key: e.key }));
  }

  has(rowId: string): boolean {
    return this.handleOf(rowId) >= 0;
  }

  /**
   * Adds a row. Returns false if the row is already here (a repeat, which is harmless) or the id is
   * one of the initial rows' names, which cannot be inserted.
   */
  insert(rowId: string, key: string): boolean {
    if (this.byId.has(rowId) || parseBaseRowId(rowId) !== null) return false;

    const entry: Entry = {
      id: rowId,
      key,
      handle: this.baseRows + this.byHandle.length,
      baseBefore: this.baseRowsBefore(key, rowId),
    };
    this.sorted.splice(this.firstNotBefore(key, rowId), 0, entry);
    this.byId.set(rowId, entry);
    this.byHandle.push(entry);
    this.cachedLayout = null;
    return true;
  }

  // ----- positions and handles ---------------------------------------------------------------

  handleAt(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) return -1;
    const before = this.insertedBeforePosition(index);
    const next = this.sorted[before];
    if (next && before + next.baseBefore === index) return next.handle;
    return index - before;
  }

  idAt(index: number): string | undefined {
    return this.idOfHandle(this.handleAt(index));
  }

  indexOfHandle(handle: number): number {
    if (handle < 0) return -1;
    if (handle < this.baseRows) return handle + this.insertedBeforeBaseRow(handle);
    const entry = this.byHandle[handle - this.baseRows];
    return entry ? this.firstNotBefore(entry.key, entry.id) + entry.baseBefore : -1;
  }

  indexOf(rowId: string): number {
    return this.indexOfHandle(this.handleOf(rowId));
  }

  /** The handle for a row id, or -1 if this replica has no such row. */
  handleOf(rowId: string): number {
    const base = parseBaseRowId(rowId);
    if (base !== null) return base < this.baseRows ? base : -1;
    return this.byId.get(rowId)?.handle ?? -1;
  }

  idOfHandle(handle: number): string | undefined {
    if (handle < 0) return undefined;
    if (handle < this.baseRows) return baseRowId(handle);
    return this.byHandle[handle - this.baseRows]?.id;
  }

  // ----- choosing keys for new rows ----------------------------------------------------------

  /**
   * Keys for `count` new rows that will sit, in order, just before the row now at `index` (so
   * index = row count appends). Each is strictly between its neighbours, and none touches any other row.
   */
  keysForInsert(index: number, count: number): string[] {
    const total = this.count;
    const lower = index > 0 ? this.keyAt(index - 1) : null;
    let upper = index < total ? this.keyAt(index) : null;

    // Two neighbours can share a key (two people inserted at the same spot at once), and no key
    // fits strictly between equal keys. Settle for landing after that whole group.
    if (lower !== null && upper !== null && compareKeys(lower, upper) >= 0) {
      let next = index;
      while (next < total && compareKeys(this.keyAt(next), lower) <= 0) next++;
      upper = next < total ? this.keyAt(next) : null;
    }

    const keys: string[] = [];
    let previous = lower;
    for (let i = 0; i < count; i++) {
      previous = between(previous, upper);
      keys.push(previous);
    }
    return keys;
  }

  private keyAt(index: number): string {
    const handle = this.handleAt(index);
    return handle < this.baseRows ? forBaseRow(handle) : this.byHandle[handle - this.baseRows].key;
  }

  // ----- snapshots ---------------------------------------------------------------------------

  /**
   * An unchanging copy of the order as it is now. Formula results are computed against one order
   * and can arrive after rows have moved, so they are read back through the order they were
   * computed against. Copies are cached until the next insert, so asking is cheap.
   */
  layout(): RowLayout {
    if (this.cachedLayout === null) {
      const copy = new RowOrder(this.baseRows);
      copy.sorted = this.sorted.slice();
      for (const [id, entry] of this.byId) copy.byId.set(id, entry);
      copy.byHandle.push(...this.byHandle);
      this.cachedLayout = copy;
    }
    return this.cachedLayout;
  }

  // ----- binary searches ---------------------------------------------------------------------

  /** Index in `sorted` of the first row that does not sort before (key, id). */
  private firstNotBefore(key: string, id: string): number {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const e = this.sorted[mid];
      if (compareRows(e.key, e.id, key, id) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** How many of the initial rows sort before (key, id). */
  private baseRowsBefore(key: string, id: string): number {
    let lo = 0;
    let hi = this.baseRows;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareRows(forBaseRow(mid), baseRowId(mid), key, id) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** How many inserted rows sort before initial row `base`. */
  private insertedBeforeBaseRow(base: number): number {
    return this.firstNotBefore(forBaseRow(base), baseRowId(base));
  }

  /** How many inserted rows are at a position before `index`. */
  private insertedBeforePosition(index: number): number {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (mid + this.sorted[mid].baseBefore < index) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
