import { toDisplayFormula } from '../formulas/formula-rows';
import { cellAddress } from '../grid/cell-address';
import type { RowOrder } from '../rows/row-order';
import { identityFromNodeId, type Identity } from '../sync/identity';
import type { HistoryStep } from './history-api';

/** Long values (a pasted paragraph, a formula with many references) are cut so the label stays one line. */
const MAX_SHOWN = 40;

export interface StepDescription {
  /** Who made the edit, from its node id. Null for a row insert, which the log records without an author. */
  readonly who: Identity | null;
  /** What happened, without the name: "set B2 to 1,250", "cleared C4", "Row 4 was inserted". */
  readonly what: string;
  /** When the editor's clock said it happened. Null for a row insert. */
  readonly at: Date | null;
}

/**
 * Says in words what a step did. `order` must be the row order of that same step, since a row's
 * number (the "4" in "B4") is its place in that version of the sheet, and the stored form of a
 * formula names rows by id and has to be turned back into numbers to be readable.
 *
 * Null for step 0, the empty sheet before any edit.
 */
export function describeStep(step: HistoryStep, order: RowOrder): StepDescription | null {
  const { op } = step;
  if (op === null) return null;

  const row = order.indexOf(op.rowId);
  if (op.kind === 'row') return { who: null, what: `Row ${row + 1} was inserted`, at: null };

  const address = cellAddress(row, op.col);
  const who = op.ts ? identityFromNodeId(op.ts.nodeId) : null;
  const at = op.ts ? new Date(op.ts.wallMs) : null;
  if (op.value === null) return { who, what: `cleared ${address}`, at };

  const typed = op.value.charAt(0) === '=' ? toDisplayFormula(op.value, order) : op.value;
  const shown = typed.length > MAX_SHOWN ? `${typed.substring(0, MAX_SHOWN - 1)}…` : typed;
  return { who, what: `set ${address} to ${shown}`, at };
}
