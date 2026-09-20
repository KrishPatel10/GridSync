import { FormulaValue } from './formula-value';

/**
 * How the evaluator sees the sheet. It only asks "what is cell (row, col) worth?", so it can be
 * tested with a Map today and driven by the dependency graph tomorrow. Mirrors ICellReader.cs.
 */
export interface CellReader {
  /** References outside this are #REF!. */
  readonly dimensions: { readonly rows: number; readonly cols: number };

  /** The value of a cell inside the sheet: a constant, or a formula's computed result. */
  getValue(row: number, col: number): FormulaValue;
}
