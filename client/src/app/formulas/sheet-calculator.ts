import { cellCol, cellKey, cellRow } from '../sync/lww-map';
import { Expr } from './ast';
import { CellReader } from './cell-reader';
import { evaluateExpr } from './formula-evaluator';
import { collectReferences } from './formula-refs';
import { displayString, EMPTY, errorValue, FormulaValue, valueFromRaw } from './formula-value';
import { parseFormula } from './parser';
import { FormulaSyntaxError } from './token';

/** A cell's new raw text, as it arrives from a local edit, a remote op, or the join snapshot. */
export interface RawChange {
  readonly row: number;
  readonly col: number;
  /** Null or empty means the cell was cleared. */
  readonly raw: string | null;
}

/** "Formula `owner` reads every cell in this rectangle." Kept as a rectangle, never expanded. */
interface RangeSub {
  readonly owner: number;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

interface FormulaCell {
  readonly raw: string;
  /** Null when the text does not parse; the cell then shows #ERROR!. */
  readonly ast: Expr | null;
  /** Single cells it reads, without duplicates, and only those inside the sheet. */
  readonly cells: readonly number[];
  readonly ranges: readonly RangeSub[];
}

/**
 * A change to what the sheet shows, as [cell key, new display text]. A null display means the
 * cell is no longer a formula, so whoever is showing a computed value for it should drop it.
 * Only cells whose display actually differs from what was last reported are listed.
 */
export type FormulaUpdate = readonly [key: number, display: string | null];

const NO_KEYS: readonly number[] = [];

/**
 * Turns a sheet of raw cell text into computed values, and keeps them right as cells change.
 *
 * Only raw text is ever synced between replicas. Each replica runs one of these over that text,
 * and because the evaluator is deterministic, every replica ends up with the same values without
 * a single computed value crossing the network.
 *
 * How an edit flows through (see recalculate):
 *   1. The edited cell is a "seed". Follow reverse edges ("who reads me?") to collect everything
 *      downstream: the affected set. Nothing outside it can change, so nothing outside it is
 *      touched. That is the "incremental" part.
 *   2. Evaluate the affected formulas in dependency order, so a cell is never computed before the
 *      cells it reads (topological order, by Kahn's algorithm: repeatedly take a cell with nothing
 *      left to wait for).
 *   3. Cells still waiting when nothing else is ready are stuck on each other: a cycle.
 *
 * A formula is #CYCLE! if it is on a cycle or reads (even indirectly) a cell that is. This is
 * decided from what a formula could read, not from the values, so all replicas agree.
 */
export class SheetCalculator implements CellReader {
  private rows = 0;
  private cols = 0;

  /** Non-formula cells, already read as numbers or text. Empty cells are simply absent. */
  private readonly constants = new Map<number, FormulaValue>();
  private readonly formulas = new Map<number, FormulaCell>();
  /** The computed result of every formula cell. */
  private readonly values = new Map<number, FormulaValue>();
  /** Formula cells that are #CYCLE!: on a cycle, or reading one. */
  private readonly cyclic = new Set<number>();
  /** The display text last reported for each formula cell, so updates list only real changes. */
  private readonly reported = new Map<number, string>();

  /** Reverse edges for single-cell reads: cell -> the formulas that read it directly. */
  private readonly dependents = new Map<number, Set<number>>();
  /**
   * Reverse edges for ranges. A range like A1:A100000 must not become 100,000 edges, so ranges
   * stay as rectangles, filed under every column they span (a sheet has few columns). Finding
   * "who reads cell (r, c)?" then means scanning only the ranges filed under column c.
   */
  private readonly rangesByColumn: Set<RangeSub>[] = [];

  private evaluations = 0;

  get dimensions(): { readonly rows: number; readonly cols: number } {
    return { rows: this.rows, cols: this.cols };
  }

  /** How many formula evaluations have run, ever. Lets tests prove an edit only recomputes what it must. */
  get evaluationCount(): number {
    return this.evaluations;
  }

  get formulaCount(): number {
    return this.formulas.size;
  }

  /**
   * References outside the sheet are #REF!, so the sheet size decides what each formula reads.
   * It only changes when joining a sheet, so a change simply rebuilds everything.
   */
  setDimensions(rows: number, cols: number): FormulaUpdate[] {
    if (rows === this.rows && cols === this.cols) return [];
    this.rows = rows;
    this.cols = cols;

    const existing = [...this.formulas.entries()];
    for (const [key, formula] of existing) this.unregister(key, formula);
    for (const [key, formula] of existing) this.register(key, formula.raw);
    return this.recalculate(this.formulas.keys());
  }

  /**
   * Applies a batch of edits, then recalculates once. A join snapshot arrives as one big batch.
   * Returns what changed on screen, for a consumer that keeps its own copy of the displays.
   */
  applyChanges(changes: Iterable<RawChange>): FormulaUpdate[] {
    const seeds = new Set<number>();

    for (const { row, col, raw } of changes) {
      const key = cellKey(row, col);
      this.clear(key);
      if (raw !== null && raw !== '') {
        if (raw.charAt(0) === '=') this.register(key, raw);
        else this.constants.set(key, valueFromRaw(raw));
      }
      seeds.add(key);
    }

    return this.recalculate(seeds);
  }

  /** The value of any cell. This is also how the evaluator reads the sheet. */
  getValue(row: number, col: number): FormulaValue {
    const key = cellKey(row, col);
    if (this.formulas.has(key)) return this.values.get(key) ?? EMPTY;
    return this.constants.get(key) ?? EMPTY;
  }

  isFormula(row: number, col: number): boolean {
    return this.formulas.has(cellKey(row, col));
  }

  /** What to show in a formula cell, or undefined if the cell is not a formula. */
  formulaDisplayAt(row: number, col: number): string | undefined {
    const key = cellKey(row, col);
    if (!this.formulas.has(key)) return undefined;
    const value = this.values.get(key);
    return value ? displayString(value) : '';
  }

  // ----- keeping the dependency graph in step with the cells --------------------------------

  /** Forgets everything about a cell, ahead of it getting new contents. */
  private clear(key: number): void {
    this.constants.delete(key);
    const formula = this.formulas.get(key);
    if (formula) {
      this.unregister(key, formula);
      this.formulas.delete(key);
    }
    this.values.delete(key);
    this.cyclic.delete(key);
  }

  /** Parses a formula and records what it reads, in both directions. */
  private register(key: number, raw: string): void {
    let ast: Expr | null = null;
    try {
      ast = parseFormula(raw);
    } catch (error) {
      if (!(error instanceof FormulaSyntaxError)) throw error;
    }

    const cells: number[] = [];
    const ranges: RangeSub[] = [];

    if (ast) {
      const refs = collectReferences(ast);

      const seen = new Set<number>();
      for (const cell of refs.cells) {
        if (!this.inSheet(cell.row, cell.col)) continue; // evaluates to #REF!, reads nothing
        const target = cellKey(cell.row, cell.col);
        if (seen.has(target)) continue;
        seen.add(target);
        cells.push(target);

        const readers = this.dependents.get(target);
        if (readers) readers.add(key);
        else this.dependents.set(target, new Set([key]));
      }

      for (const range of refs.ranges) {
        if (!this.inSheet(range.bottomRight.row, range.bottomRight.col)) continue; // #REF! too
        const sub: RangeSub = {
          owner: key,
          top: range.topLeft.row,
          bottom: range.bottomRight.row,
          left: range.topLeft.col,
          right: range.bottomRight.col,
        };
        ranges.push(sub);
        for (let col = sub.left; col <= sub.right; col++) (this.rangesByColumn[col] ??= new Set()).add(sub);
      }
    }

    this.formulas.set(key, { raw, ast, cells, ranges });
  }

  private unregister(key: number, formula: FormulaCell): void {
    for (const target of formula.cells) {
      const readers = this.dependents.get(target);
      if (!readers) continue;
      readers.delete(key);
      if (readers.size === 0) this.dependents.delete(target);
    }
    for (const sub of formula.ranges) {
      for (let col = sub.left; col <= sub.right; col++) this.rangesByColumn[col]?.delete(sub);
    }
  }

  private inSheet(row: number, col: number): boolean {
    return row < this.rows && col < this.cols;
  }

  /** Every formula that reads this cell, directly or through a range, each listed once. */
  private dependentsOf(key: number): readonly number[] {
    const direct = this.dependents.get(key);
    const bucket = this.rangesByColumn[cellCol(key)];

    let viaRanges: number[] | undefined;
    if (bucket && bucket.size > 0) {
      const row = cellRow(key);
      for (const sub of bucket) if (row >= sub.top && row <= sub.bottom) (viaRanges ??= []).push(sub.owner);
    }

    if (!viaRanges) return direct ? [...direct] : NO_KEYS;
    // A formula can reach the same cell through several routes (two ranges, or a range and a cell).
    return [...new Set([...(direct ?? NO_KEYS), ...viaRanges])];
  }

  // ----- recalculation -----------------------------------------------------------------------

  private recalculate(seedKeys: Iterable<number>): FormulaUpdate[] {
    // Step 1: the affected set, discovered breadth-first along reverse edges. Each edge that is
    // found is remembered, and each cell counts how many affected cells it is still waiting on.
    const affected: number[] = [];
    const known = new Set<number>();
    for (const key of seedKeys) {
      if (known.has(key)) continue;
      known.add(key);
      affected.push(key);
    }

    const downstream = new Map<number, readonly number[]>();
    const waitingOn = new Map<number, number>();
    for (let i = 0; i < affected.length; i++) {
      const key = affected[i];
      const readers = this.dependentsOf(key);
      if (readers.length === 0) continue;

      downstream.set(key, readers);
      for (const reader of readers) {
        waitingOn.set(reader, (waitingOn.get(reader) ?? 0) + 1);
        if (!known.has(reader)) {
          known.add(reader);
          affected.push(reader);
        }
      }
    }

    // Anything about to be recomputed gets its cycle flag re-decided from scratch; flags on cells
    // outside the affected set are still valid and are kept.
    for (const key of affected) this.cyclic.delete(key);

    // Step 2: Kahn's algorithm. A cell is ready once every affected cell it reads is done.
    const ready = affected.filter((key) => !waitingOn.has(key));
    for (let i = 0; i < ready.length; i++) {
      const key = ready[i];
      this.compute(key);

      for (const reader of downstream.get(key) ?? NO_KEYS) {
        const remaining = (waitingOn.get(reader) as number) - 1;
        if (remaining === 0) {
          waitingOn.delete(reader);
          ready.push(reader);
        } else {
          waitingOn.set(reader, remaining);
        }
      }
    }

    // Step 3: whatever is still waiting is waiting on something that never finishes. That is a
    // cycle, or a cell reading one.
    for (const key of waitingOn.keys()) this.markCyclic(key);

    return this.collectUpdates(affected);
  }

  /** Compares each affected cell's display with what was last reported, and lists the differences. */
  private collectUpdates(affected: readonly number[]): FormulaUpdate[] {
    const updates: FormulaUpdate[] = [];
    for (const key of affected) {
      const value = this.formulas.has(key) ? this.values.get(key) : undefined;
      if (value) {
        const display = displayString(value);
        if (this.reported.get(key) !== display) {
          this.reported.set(key, display);
          updates.push([key, display]);
        }
      } else if (this.reported.delete(key)) {
        updates.push([key, null]);
      }
    }
    return updates;
  }

  private compute(key: number): void {
    const formula = this.formulas.get(key);
    if (!formula) return; // a constant, or a cell that was cleared: nothing to evaluate

    if (!formula.ast) {
      this.values.set(key, errorValue('#ERROR!'));
    } else if (this.cyclic.size > 0 && this.readsCyclicCell(formula)) {
      this.markCyclic(key);
    } else {
      this.evaluations++;
      this.values.set(key, evaluateExpr(formula.ast, this));
    }
  }

  private markCyclic(key: number): void {
    this.cyclic.add(key);
    this.values.set(key, errorValue('#CYCLE!'));
  }

  /**
   * Catches a formula that was just edited to read a cycle that already existed: that cycle is
   * not in the affected set, so the waiting-count above cannot see it. Checks the formula's own
   * references against the flagged cells, walking whichever side is smaller.
   */
  private readsCyclicCell(formula: FormulaCell): boolean {
    for (const target of formula.cells) if (this.cyclic.has(target)) return true;

    for (const sub of formula.ranges) {
      const area = (sub.bottom - sub.top + 1) * (sub.right - sub.left + 1);
      if (area <= this.cyclic.size) {
        for (let row = sub.top; row <= sub.bottom; row++) {
          for (let col = sub.left; col <= sub.right; col++) if (this.cyclic.has(cellKey(row, col))) return true;
        }
      } else {
        for (const flagged of this.cyclic) {
          const row = cellRow(flagged);
          const col = cellCol(flagged);
          if (row >= sub.top && row <= sub.bottom && col >= sub.left && col <= sub.right) return true;
        }
      }
    }
    return false;
  }
}
