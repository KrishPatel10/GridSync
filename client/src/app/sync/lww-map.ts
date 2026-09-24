import { compareHlc, HlcTimestamp } from './hlc';
import { CellEntry } from './sync.models';

/**
 * One write to one cell, with the row named by a handle (a small number local to this replica; see
 * RowOrder) rather than by the wire's row id. Cell storage only ever needs to tell rows apart, and a
 * number makes a cheaper map key than a 32 character id.
 */
export interface CellWrite {
  readonly row: number;
  readonly col: number;
  readonly value: string | null;
  readonly ts: HlcTimestamp;
}

/** Excel's column limit. Multiplying by it keeps numeric keys unique for any sheet we allow. */
const COL_SPACE = 16_384;

export function cellKey(row: number, col: number): number {
  return row * COL_SPACE + col;
}

export function cellRow(key: number): number {
  return Math.floor(key / COL_SPACE);
}

export function cellCol(key: number): number {
  return key % COL_SPACE;
}

/**
 * Client-side replica of a sheet: one last-writer-wins register per cell, merged with the same
 * rule as GridSync.Core.SheetState. Local edits, remote broadcasts, and join snapshots all go
 * through apply(), so arrival order never matters.
 */
export class LwwCellMap {
  private readonly cells = new Map<number, CellEntry>();
  private filled = 0;

  /** Returns true if the op won and changed state; false if it was stale or a duplicate. */
  apply(op: CellWrite): boolean {
    const key = cellKey(op.row, op.col);
    const current = this.cells.get(key);
    if (current && compareHlc(op.ts, current.ts) <= 0) return false;

    if (current && current.value !== null) this.filled--;
    if (op.value !== null) this.filled++;
    this.cells.set(key, { value: op.value, ts: op.ts });
    return true;
  }

  get(row: number, col: number): CellEntry | undefined {
    return this.cells.get(cellKey(row, col));
  }

  /** Cells holding a value (cleared cells are kept as tombstones but not counted). */
  get filledCount(): number {
    return this.filled;
  }

  /** Calls `visit` for every cell holding a value. The cost is the number of stored cells, not the size of the sheet. */
  forEachFilled(visit: (row: number, col: number, value: string) => void): void {
    for (const [key, entry] of this.cells) {
      if (entry.value !== null) visit(Math.floor(key / COL_SPACE), key % COL_SPACE, entry.value);
    }
  }

  /** Every winning write, tombstones included, in no particular order. */
  toOps(): CellWrite[] {
    const ops: CellWrite[] = [];
    for (const [key, entry] of this.cells) {
      ops.push({ row: Math.floor(key / COL_SPACE), col: key % COL_SPACE, value: entry.value, ts: entry.ts });
    }
    return ops;
  }
}
