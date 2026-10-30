import { Injectable, signal } from '@angular/core';
import { InlineFormulaBackend } from '../formulas/formula-backend';
import { toDisplayFormula } from '../formulas/formula-rows';
import { RawChange } from '../formulas/sheet-calculator';
import { displaysInBlock, type Block, type GridData } from '../grid/grid-data';
import { RowOrder } from '../rows/row-order';
import { identityFromNodeId } from '../sync/identity';
import { cellCol, cellKey, cellRow, LwwCellMap } from '../sync/lww-map';
import type { ConnectionState, UserPresence } from '../sync/sync.models';
import type { HistoryStep } from './history-api';

const NO_PEERS: readonly UserPresence[] = [];

/** The text of a cell as a person types and reads it: formulas name rows by number, not by id. */
function asTyped(raw: string, order: RowOrder): string {
  return raw.charAt(0) === '=' ? toDisplayFormula(raw, order) : raw;
}

/**
 * The grid's data source for one past version of a sheet: read-only, and replaced whole each time
 * the person moves the history slider.
 *
 * It builds what the live sheet builds from a join, from the same pieces: the rows into a RowOrder,
 * the cells into a cell map, and the formulas run through the same calculator (here on this thread,
 * which is fine for a one-off pass over a snapshot). So formulas show their computed values in
 * history, and follow inserted rows the same way. No people are shown: presence is not recorded,
 * and nothing here is live.
 */
@Injectable()
export class HistoryGridData implements GridData {
  readonly readOnly = true;
  readonly state = signal<ConnectionState>('live').asReadonly();

  private order = new RowOrder(0);
  private cells = new LwwCellMap();
  private displays = new Map<number, string>();
  /** The cell the current step changed, so the grid can flash it in its author's ink. */
  private changed: { readonly key: number; readonly color: string } | null = null;

  private readonly _version = signal(0);
  private readonly _layoutVersion = signal(0);
  private readonly _dims = signal({ rows: 0, cols: 0 });
  readonly dims = this._dims.asReadonly();

  /** The row order of the step now showing: for turning a row id into the number the person sees. */
  get rowOrder(): RowOrder {
    return this.order;
  }

  /** Replaces what the grid shows with this version of the sheet. */
  load(step: HistoryStep): void {
    const order = new RowOrder(step.rows);
    for (const row of step.insertedRows) order.insert(row.rowId, row.key);

    const cells = new LwwCellMap();
    for (const op of step.cells) {
      const handle = order.handleOf(op.rowId);
      if (handle >= 0) cells.apply({ row: handle, col: op.col, value: op.value, ts: op.ts });
    }

    this.order = order;
    this.cells = cells;
    this.displays = calculate(order, cells, step.cols);
    this.changed = changedCell(step, order);

    this._dims.set({ rows: order.count, cols: step.cols });
    this._layoutVersion.update((v) => v + 1);
    this._version.update((v) => v + 1);
  }

  handleAt(row: number): number {
    this._layoutVersion();
    return this.order.handleAt(row);
  }

  indexOfHandle(handle: number): number {
    this._layoutVersion();
    return this.order.indexOfHandle(handle);
  }

  valueAt(row: number, col: number): string {
    this._version();
    return asTyped(this.cells.get(this.order.handleAt(row), col)?.value ?? '', this.order);
  }

  displayAt(row: number, col: number): string {
    this._version();
    const handle = this.order.handleAt(row);
    const raw = this.cells.get(handle, col)?.value ?? '';
    return raw.charAt(0) === '=' ? (this.displays.get(cellKey(handle, col)) ?? '') : raw;
  }

  displaysIn(block: Block): string[] {
    this._version();
    return displaysInBlock(block, this.cells, this.order, (row, col) => this.displayAt(row, col));
  }

  peersAt(): readonly UserPresence[] {
    return NO_PEERS;
  }

  flashAt(row: number, col: number): string | undefined {
    this._version();
    return this.changed?.key === cellKey(this.order.handleAt(row), col) ? this.changed.color : undefined;
  }

  // A past version cannot be changed. The grid checks readOnly before it gets here; these are the
  // backstop, so a missed check does nothing instead of writing.

  setCell(): void {
    // read-only
  }

  insertRows(row: number): number {
    return row;
  }

  shareSelection(): void {
    // read-only, and nobody is watching
  }
}

/** Runs every formula in a snapshot and returns what each one shows, by cell key. */
function calculate(order: RowOrder, cells: LwwCellMap, cols: number): Map<number, string> {
  const displays = new Map<number, string>();
  const calculator = new InlineFormulaBackend();
  calculator.onUpdates = (updates) => {
    for (const [key, display] of updates) {
      const handle = order.handleAt(cellRow(key));
      if (handle < 0) continue;
      if (display === null) displays.delete(cellKey(handle, cellCol(key)));
      else displays.set(cellKey(handle, cellCol(key)), display);
    }
  };

  const changes: RawChange[] = [];
  cells.forEachFilled((handle, col, value) => {
    const row = order.indexOfHandle(handle);
    if (row >= 0) changes.push({ row, col, raw: asTyped(value, order) });
  });
  calculator.reset(order.count, cols, changes);
  return displays;
}

function changedCell(step: HistoryStep, order: RowOrder): { key: number; color: string } | null {
  const { op } = step;
  if (op?.kind !== 'cell' || op.ts === null) return null;
  const handle = order.handleOf(op.rowId);
  return handle < 0 ? null : { key: cellKey(handle, op.col), color: identityFromNodeId(op.ts.nodeId).color };
}
