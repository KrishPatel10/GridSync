import vectorFile from '../../../../spec/formula-vectors.json';
import { evaluateFormula } from './formula-evaluator';
import { booleanValue, displayString, errorValue, FormulaError, FormulaValue, numberValue, textValue, valueFromRaw } from './formula-value';
import { TestCells } from './testing/test-cells';

/**
 * Runs spec/formula-vectors.json, the same file the C# engine's xUnit tests run. If the two
 * engines ever disagree about a formula, one of these two suites fails on the same line.
 */
interface Vector {
  readonly name: string;
  readonly formula: string;
  readonly cells?: Readonly<Record<string, string | null | { readonly error: string }>>;
  readonly expected: {
    readonly type: 'number' | 'text' | 'boolean' | 'error';
    readonly value: number | string | boolean;
    readonly display?: string;
  };
}

const file = vectorFile as unknown as {
  readonly sheet: { readonly rows: number; readonly cols: number };
  readonly vectors: readonly Vector[];
};

function readCell(cell: string | null | { readonly error: string }): FormulaValue {
  if (cell !== null && typeof cell === 'object') return errorValue(cell.error as FormulaError);
  return valueFromRaw(cell);
}

function expectedValue(expected: Vector['expected']): FormulaValue {
  switch (expected.type) {
    case 'number':
      return numberValue(expected.value as number);
    case 'text':
      return textValue(expected.value as string);
    case 'boolean':
      return booleanValue(expected.value as boolean);
    case 'error':
      return errorValue(expected.value as FormulaError);
  }
}

describe('shared formula vectors', () => {
  it('has the required number of cases with unique names', () => {
    const names = file.vectors.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(60);
  });

  it('covers every operator, function and error', () => {
    const formulas = file.vectors.map((v) => v.formula.toUpperCase());
    const errors = new Set(file.vectors.filter((v) => v.expected.type === 'error').map((v) => v.expected.value));

    const symbols = ['+', '-', '*', '/', '^', '&', '=', '<>', '<=', '>=', '<', '>', 'SUM(', 'AVERAGE(', 'MIN(', 'MAX(', 'COUNT(', 'IF(', 'ROUND('];
    // #CYCLE! is not producible by the evaluator on its own; the dependency graph adds it later.
    const errorCodes = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#ERROR!'];

    for (const symbol of symbols) expect(formulas.some((f) => f.includes(symbol))).toBe(true);
    for (const code of errorCodes) expect(errors.has(code)).toBe(true);
  });

  it.each(file.vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const cells = new TestCells(file.sheet);
    for (const [address, cell] of Object.entries(vector.cells ?? {})) cells.value(address, readCell(cell));

    const actual = evaluateFormula(vector.formula, cells);

    expect(actual).toEqual(expectedValue(vector.expected));
    if (vector.expected.display !== undefined) expect(displayString(actual)).toBe(vector.expected.display);
  });
});
