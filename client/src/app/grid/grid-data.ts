import { InjectionToken, Signal } from '@angular/core';
import type { LwwCellMap } from '../sync/lww-map';
import type { ConnectionState, UserPresence } from '../sync/sync.models';
import type { RowOrder } from '../rows/row-order';

/** A rectangle of cells by position: both ends included. */
export interface Block {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/**
 * Everything the grid needs from whatever it is showing. The live sheet is one source
 * (SheetSyncService); a past version in the history view is another (HistoryGridData). The grid draws
 * and handles keys the same way for both, and a read-only source is how it knows to hold back from
 * anything that would write.
 *
 * Rows are addressed by position, what the grid works in. A handle names a row for good however rows
 * move (see RowOrder), which is how a selection follows its row when rows are inserted.
 */
export interface GridData {
  /** True when nothing the person does in the grid may change the sheet. */
  readonly readOnly: boolean;
  readonly state: Signal<ConnectionState>;
  readonly dims: Signal<{ rows: number; cols: number }>;

  handleAt(row: number): number;
  indexOfHandle(handle: number): number;
  /** The text of a cell as it is typed: what the formula bar and the editor show. */
  valueAt(row: number, col: number): string;
  /** What the grid shows in a cell: a formula's result, or the raw text. */
  displayAt(row: number, col: number): string;
  /** The displayed text of the non-empty cells in a block. */
  displaysIn(block: Block): string[];
  peersAt(row: number, col: number): readonly UserPresence[];
  /** The ink color of whoever just changed this cell, or undefined if nothing just changed. */
  flashAt(row: number, col: number): string | null | undefined;

  setCell(row: number, col: number, value: string | null): void;
  /** Returns the position of the first new row. */
  insertRows(row: number, count: number): number;
  shareSelection(row: number, col: number): void;
}

/** Provided in app.config.ts as the live sheet; the history view provides its own. */
export const GRID_DATA = new InjectionToken<GridData>('GRID_DATA');

/**
 * The displayed text of the non-empty cells in a block. Walks whichever is smaller, the block or the
 * set of stored cells, so selecting the whole sheet doesn't visit 2.6 million empty cells.
 */
export function displaysInBlock(
  block: Block,
  cells: LwwCellMap,
  order: RowOrder,
  displayAt: (row: number, col: number) => string,
): string[] {
  const out: string[] = [];
  const area = (block.bottom - block.top + 1) * (block.right - block.left + 1);

  if (area <= cells.filledCount) {
    for (let row = block.top; row <= block.bottom; row++) {
      for (let col = block.left; col <= block.right; col++) out.push(displayAt(row, col));
    }
  } else {
    cells.forEachFilled((handle, col) => {
      const row = order.indexOfHandle(handle);
      if (row >= block.top && row <= block.bottom && col >= block.left && col <= block.right) {
        out.push(displayAt(row, col));
      }
    });
  }
  return out;
}
