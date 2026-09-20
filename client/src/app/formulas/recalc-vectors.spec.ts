import recalcFile from '../../../../spec/recalc-vectors.json';
import { cellAddress } from '../grid/cell-address';
import { tryParseCellAddress } from './cell-ref';
import { FormulaUpdate, RawChange, SheetCalculator } from './sheet-calculator';

/**
 * Replays spec/recalc-vectors.json, the same file the C# calculator's xUnit tests replay. Each
 * scenario is a series of edits; after each one the results, the number of formulas evaluated,
 * and the updates reported must all match.
 */
interface Step {
  readonly set?: Readonly<Record<string, string | null>>;
  readonly dimensions?: { readonly rows: number; readonly cols: number };
  readonly expect: Readonly<Record<string, string>>;
  readonly evaluated?: number;
  readonly updates?: Readonly<Record<string, string | null>>;
}

interface Scenario {
  readonly name: string;
  readonly sheet?: { readonly rows: number; readonly cols: number };
  readonly steps: readonly Step[];
}

const file = recalcFile as unknown as {
  readonly sheet: { readonly rows: number; readonly cols: number };
  readonly scenarios: readonly Scenario[];
};

const COLUMN_SPACE = 16_384; // the packing used by cellKey

function address(key: number): string {
  return cellAddress(Math.floor(key / COLUMN_SPACE), key % COLUMN_SPACE);
}

function describe_(map: ReadonlyMap<string, string | null>): string {
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v ?? 'null'}`)
    .join(', ');
}

describe('shared recalculation scenarios', () => {
  it('has the important behaviours covered, with unique names', () => {
    const names = file.scenarios.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(20);
  });

  it.each(file.scenarios.map((s) => [s.name, s] as const))('%s', (name, scenario) => {
    const sheet = scenario.sheet ?? file.sheet;
    const calc = new SheetCalculator();
    calc.setDimensions(sheet.rows, sheet.cols);
    const raws = new Map<string, string | null>();

    scenario.steps.forEach((step, index) => {
      const where = `scenario '${name}', step ${index + 1}`;
      const evaluatedBefore = calc.evaluationCount;
      let updates: readonly FormulaUpdate[];

      if (step.set) {
        const changes: RawChange[] = Object.entries(step.set).map(([cell, raw]) => {
          const position = tryParseCellAddress(cell);
          if (!position) throw new Error(`bad address ${cell}`);
          raws.set(cell, raw);
          return { ...position, raw };
        });
        updates = calc.applyChanges(changes);
      } else if (step.dimensions) {
        updates = calc.setDimensions(step.dimensions.rows, step.dimensions.cols);
      } else {
        throw new Error(`${where}: a step needs 'set' or 'dimensions'`);
      }

      for (const [cell, expected] of Object.entries(step.expect)) {
        const position = tryParseCellAddress(cell) as { row: number; col: number };
        const shown = calc.formulaDisplayAt(position.row, position.col) ?? raws.get(cell) ?? '';
        expect(shown, `${where}: ${cell}`).toBe(expected);
      }

      if (step.evaluated !== undefined) {
        expect(calc.evaluationCount - evaluatedBefore, `${where}: formulas evaluated`).toBe(step.evaluated);
      }

      if (step.updates) {
        const expectedMap = new Map(Object.entries(step.updates));
        const actualMap = new Map(updates.map(([key, display]) => [address(key), display] as const));
        expect(describe_(actualMap), `${where}: updates`).toBe(describe_(expectedMap));
      }
    });
  });
});
