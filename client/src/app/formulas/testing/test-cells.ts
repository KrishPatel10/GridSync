import { tryParseCellAddress } from '../cell-ref';
import { CellReader } from '../cell-reader';
import { EMPTY, FormulaValue, valueFromRaw } from '../formula-value';

/** Test-only. A sheet made of a Map: anything not in it is empty. Counts reads for laziness tests. */
export class TestCells implements CellReader {
  private readonly cells = new Map<string, FormulaValue>();
  reads = 0;

  constructor(readonly dimensions: { readonly rows: number; readonly cols: number } = { rows: 100_000, cols: 26 }) {}

  /** Puts a constant in a cell using A1 notation, read the way a typed cell is read. */
  raw(address: string, raw: string | null): this {
    return this.value(address, valueFromRaw(raw));
  }

  value(address: string, value: FormulaValue): this {
    const position = tryParseCellAddress(address);
    if (!position) throw new Error(`bad address ${address}`);
    this.cells.set(`${position.row},${position.col}`, value);
    return this;
  }

  getValue(row: number, col: number): FormulaValue {
    this.reads++;
    return this.cells.get(`${row},${col}`) ?? EMPTY;
  }
}
