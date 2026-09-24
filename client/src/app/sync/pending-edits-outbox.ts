import { compareHlc } from './hlc';
import { OutboxRecord, OutboxStorage } from './outbox-storage';
import { CellOp, RowOp } from './sync.models';

/** What an abandoned tab left behind: rows it inserted and the latest edit to each cell it touched. */
export interface RecoveredEdits {
  readonly rows: RowOp[];
  readonly cells: CellOp[];
}

/**
 * Keeps a tab's unsent edits durable, so closing the tab (or the browser crashing) while offline
 * loses nothing: reopening the sheet recovers them.
 *
 * Recovery does not try to resurrect the old tab's identity. Reusing its node id would risk two
 * tabs racing to adopt the same one (the hub binds ops to the node id a connection joined with,
 * so a collision would make one tab's edits look forged). Instead, a recovered edit is replayed
 * as a brand-new local edit under the current tab's own identity: same cell, same value, a fresh
 * timestamp. The exact old timestamp never mattered for correctness, only that the cell ends up
 * holding the value the person typed.
 *
 * Rows are the exception, and safely: a row's id is random and its key is fixed, so replaying a row
 * insert as it was is just a retry (inserting the same row twice changes nothing), and the cells
 * that were typed into it need that very row to exist.
 */
export class PendingEditsOutbox {
  constructor(
    private readonly storage: OutboxStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Finds every abandoned record for this sheet (written more than staleAfterMs ago) and returns
   * the edits worth replaying: the rows, and the latest write per cell, across all of them. A record
   * is left alone, not harvested, if it was touched recently: that means its tab is still alive (a
   * live tab keeps refreshing its own record; see heartbeat in sheet-sync.service.ts), and taking
   * its edits would race with that tab still holding and eventually sending them itself.
   */
  async harvestStaleOps(sheetId: string, staleAfterMs: number): Promise<RecoveredEdits> {
    const records = await this.storage.getForSheet(sheetId);
    const cutoff = this.now() - staleAfterMs;
    const stale = records.filter((r) => (r.ops.length > 0 || (r.rows?.length ?? 0) > 0) && r.lastSeenMs <= cutoff);

    await Promise.all(stale.map((r) => this.storage.delete(r.sheetId, r.nodeId)));

    return { rows: uniqueRows(stale), cells: mergeLatestPerCell(stale) };
  }

  /** Persists (or, once nothing is left, deletes) this tab's own unsent edits for a sheet. */
  async persist(sheetId: string, nodeId: string, ops: readonly CellOp[], rows: readonly RowOp[] = []): Promise<void> {
    if (ops.length === 0 && rows.length === 0) {
      await this.storage.delete(sheetId, nodeId);
      return;
    }
    await this.storage.put({ sheetId, nodeId, ops: [...ops], rows: [...rows], lastSeenMs: this.now() });
  }
}

/** A stored op, whether it was written by this version (a row id) or an older one (a row number). */
function rowIdOf(op: CellOp): string {
  const legacy = op as unknown as { row?: number };
  return op.rowId ?? `b${legacy.row}`;
}

function uniqueRows(records: readonly OutboxRecord[]): RowOp[] {
  const byId = new Map<string, RowOp>();
  for (const record of records) for (const row of record.rows ?? []) byId.set(row.rowId, row);
  return [...byId.values()];
}

/** The newest op per (row, col) across every record, in case two abandoned records touched the same cell. */
function mergeLatestPerCell(records: readonly OutboxRecord[]): CellOp[] {
  const latest = new Map<string, CellOp>();
  for (const record of records) {
    for (const stored of record.ops) {
      const op: CellOp = { ...stored, rowId: rowIdOf(stored) };
      const key = `${op.rowId}:${op.col}`;
      const current = latest.get(key);
      if (!current || compareHlc(op.ts, current.ts) > 0) latest.set(key, op);
    }
  }
  return [...latest.values()];
}
