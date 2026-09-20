import { cellAddress } from '../grid/cell-address';
import { CellRef, Expr } from './ast';
import { evaluateExpr } from './formula-evaluator';
import { displayString, errorValue, FormulaValue, numberValue, valueFromRaw } from './formula-value';
import { parseFormula } from './parser';
import { RawChange, SheetCalculator } from './sheet-calculator';
import { tryParseCellAddress } from './cell-ref';
import { FormulaSyntaxError } from './token';

/** Sets cells by A1 address, e.g. put(calc, { A1: '10', B1: '=A1*2' }). */
function put(calc: SheetCalculator, cells: Record<string, string | null>): void {
  const changes: RawChange[] = Object.entries(cells).map(([address, raw]) => {
    const position = tryParseCellAddress(address);
    if (!position) throw new Error(`bad address ${address}`);
    return { ...position, raw };
  });
  calc.applyChanges(changes);
}

/** What the sheet would show in a cell: the computed value for formulas, the raw text otherwise. */
function shown(calc: SheetCalculator, address: string, raw?: string | null): string {
  const position = tryParseCellAddress(address);
  if (!position) throw new Error(`bad address ${address}`);
  return calc.formulaDisplayAt(position.row, position.col) ?? raw ?? '';
}

function newCalculator(rows = 100_000, cols = 26): SheetCalculator {
  const calc = new SheetCalculator();
  calc.setDimensions(rows, cols);
  return calc;
}

describe('SheetCalculator', () => {
  it('computes a formula with no references', () => {
    const calc = newCalculator();
    put(calc, { A1: '=5+3' });
    expect(shown(calc, 'A1')).toBe('8');
  });

  it('leaves ordinary cells alone', () => {
    const calc = newCalculator();
    put(calc, { A1: 'hello', A2: '42' });
    expect(calc.isFormula(0, 0)).toBe(false);
    expect(calc.formulaDisplayAt(0, 0)).toBeUndefined();
    expect(calc.getValue(1, 0)).toEqual(numberValue(42));
  });

  it('follows references and updates them when the cell they read changes', () => {
    const calc = newCalculator();
    put(calc, { A1: '10', B1: '=A1*2' });
    expect(shown(calc, 'B1')).toBe('20');

    put(calc, { A1: '7' });
    expect(shown(calc, 'B1')).toBe('14');
  });

  it('computes a cell before the cells that read it, however they were entered', () => {
    const calc = newCalculator();
    // C1 reads B1, which reads A1. Entered in the "wrong" order on purpose, in one batch.
    put(calc, { C1: '=A1+B1', B1: '=A1*2', A1: '5' });
    expect(shown(calc, 'B1')).toBe('10');
    expect(shown(calc, 'C1')).toBe('15');

    put(calc, { A1: '1' });
    expect(shown(calc, 'C1')).toBe('3'); // needs the new B1 (2), not the stale one (10)
  });

  it('updates a formula that reads a cell which was empty when the formula was written', () => {
    const calc = newCalculator();
    put(calc, { B1: '=A1+1' });
    expect(shown(calc, 'B1')).toBe('1');

    put(calc, { A1: '4' });
    expect(shown(calc, 'B1')).toBe('5');

    put(calc, { A1: null });
    expect(shown(calc, 'B1')).toBe('1');
  });

  it('recalculates a range when any cell inside it changes, including one that was empty', () => {
    const calc = newCalculator();
    put(calc, { A1: '1', A3: '3', B1: '=SUM(A1:A3)' });
    expect(shown(calc, 'B1')).toBe('4');

    put(calc, { A2: '10' });
    expect(shown(calc, 'B1')).toBe('14');

    put(calc, { A4: '100' }); // just outside the range: must not matter
    expect(shown(calc, 'B1')).toBe('14');
  });

  it('handles a range that spans several columns', () => {
    const calc = newCalculator();
    put(calc, { A1: '1', B2: '2', C3: '3', E1: '=SUM(A1:C3)' });
    expect(shown(calc, 'E1')).toBe('6');

    put(calc, { C2: '10' });
    expect(shown(calc, 'E1')).toBe('16');
  });

  it('switches a cell between constant, formula and empty', () => {
    const calc = newCalculator();
    put(calc, { A1: '2', B1: '=A1+1' });

    put(calc, { A1: '=10*10' });
    expect(shown(calc, 'A1')).toBe('100');
    expect(shown(calc, 'B1')).toBe('101');

    put(calc, { A1: 'text' });
    expect(calc.isFormula(0, 0)).toBe(false);
    expect(shown(calc, 'B1')).toBe('#VALUE!');

    put(calc, { A1: null });
    expect(shown(calc, 'B1')).toBe('1');
  });

  it('shows #ERROR! for text that does not parse, and recovers when fixed', () => {
    const calc = newCalculator();
    put(calc, { A1: '=1+' });
    expect(shown(calc, 'A1')).toBe('#ERROR!');

    put(calc, { A1: '=1+2' });
    expect(shown(calc, 'A1')).toBe('3');
  });

  it('shows #REF! for cells outside the sheet, and follows the sheet size', () => {
    const calc = newCalculator(10, 3);
    // Column B reads column A (and beyond), so no formula reads itself.
    put(calc, { B1: '=D1', B2: '=A11', B3: '=SUM(A1:A11)', B4: '=C10' });
    const results = () => ['B1', 'B2', 'B3', 'B4'].map((a) => shown(calc, a));

    expect(results()).toEqual(['#REF!', '#REF!', '#REF!', '0']); // only C10 is inside 10 x 3

    calc.setDimensions(20, 5);
    expect(results()).toEqual(['0', '0', '0', '0']);

    calc.setDimensions(10, 3);
    expect(results()).toEqual(['#REF!', '#REF!', '#REF!', '0']);
  });

  it('shows the same error the evaluator does', () => {
    const calc = newCalculator();
    put(calc, { A1: '=1/0', B1: '=A1+1', C1: '=SUM(A1:B1)', D1: '=COUNT(A1:B1)' });
    expect(['A1', 'B1', 'C1', 'D1'].map((a) => shown(calc, a))).toEqual(['#DIV/0!', '#DIV/0!', '#DIV/0!', '0']);
  });

  describe('circular references', () => {
    it('flags a cell that reads itself', () => {
      const calc = newCalculator();
      put(calc, { A1: '=A1+1' });
      expect(shown(calc, 'A1')).toBe('#CYCLE!');
    });

    it('flags both cells of a two-cell cycle, and a cell that reads them', () => {
      const calc = newCalculator();
      put(calc, { A1: '=B1', B1: '=A1', C1: '=A1+1', D1: '=5' });
      expect(['A1', 'B1', 'C1', 'D1'].map((a) => shown(calc, a))).toEqual(['#CYCLE!', '#CYCLE!', '#CYCLE!', '5']);
    });

    it('detects a longer cycle', () => {
      const calc = newCalculator();
      put(calc, { A1: '=B1', B1: '=C1', C1: '=D1', D1: '=A1' });
      expect(['A1', 'B1', 'C1', 'D1'].map((a) => shown(calc, a))).toEqual(Array(4).fill('#CYCLE!'));
    });

    it('detects a cycle made of two edits that each looked fine alone', () => {
      // What concurrent editing produces: Alice sets A1 to =B1 while offline, Bob sets B1 to =A1.
      // Neither saw a cycle, and after the merge both edits arrive together.
      const calc = newCalculator();
      put(calc, { A1: '=B1' });
      put(calc, { B1: '=A1' });
      expect(shown(calc, 'A1')).toBe('#CYCLE!');
      expect(shown(calc, 'B1')).toBe('#CYCLE!');
    });

    it('recovers every cell when the cycle is broken', () => {
      const calc = newCalculator();
      put(calc, { A1: '=B1', B1: '=A1', C1: '=A1+1' });

      put(calc, { B1: '7' });
      expect(['A1', 'B1', 'C1'].map((a) => shown(calc, a, a === 'B1' ? '7' : undefined))).toEqual(['7', '7', '8']);
    });

    it('flags a cell that is edited to read a cycle that already exists', () => {
      const calc = newCalculator();
      put(calc, { A1: '=B1', B1: '=A1' });

      put(calc, { C1: '=A1+1', D1: '=SUM(A1:B1)' });
      expect(shown(calc, 'C1')).toBe('#CYCLE!');
      expect(shown(calc, 'D1')).toBe('#CYCLE!');
    });

    it('flags a formula that only reads the cycle in a branch that does not run', () => {
      // Dependencies are about what a formula could read, so every replica agrees on this.
      const calc = newCalculator();
      put(calc, { A1: '=B1', B1: '=A1' });
      put(calc, { C1: '=IF(TRUE,1,A1)' });
      expect(shown(calc, 'C1')).toBe('#CYCLE!');
    });

    it('does not keep a stale flag on cells downstream of a broken cycle', () => {
      const calc = newCalculator();
      put(calc, { A1: '=A1', B1: '=A1', C1: '=B1' });
      expect(shown(calc, 'C1')).toBe('#CYCLE!');

      put(calc, { A1: '3' });
      expect(shown(calc, 'C1')).toBe('3');
    });
  });

  describe('incremental recalculation', () => {
    it('recomputes only the formulas downstream of the edit', () => {
      const calc = newCalculator();
      put(calc, {
        A1: '1',
        B1: '=A1+1',
        B2: '=A1*2',
        C1: '=B1+B2', // downstream through both
        D1: '=SUM(A1:A3)', // downstream through a range
        E1: '=99', // unrelated
        F1: '=E1+1', // unrelated
      });

      const before = calc.evaluationCount;
      put(calc, { A1: '5' });

      // B1, B2, C1 and D1, each exactly once. E1 and F1 are not touched.
      expect(calc.evaluationCount - before).toBe(4);
      expect(['B1', 'B2', 'C1', 'D1', 'F1'].map((a) => shown(calc, a))).toEqual(['6', '10', '16', '5', '100']);
    });

    it('evaluates each affected formula once even when it is reached by several routes', () => {
      const calc = newCalculator();
      put(calc, { A1: '1', B1: '=A1', C1: '=A1', D1: '=B1+C1+A1+SUM(A1:C1)' });

      const before = calc.evaluationCount;
      put(calc, { A1: '2' });
      expect(calc.evaluationCount - before).toBe(3); // B1, C1, D1
    });

    it('does no work for a cell nothing reads', () => {
      const calc = newCalculator();
      put(calc, { A1: '1', B1: '=A1' });

      const before = calc.evaluationCount;
      put(calc, { Z9: 'anything' });
      expect(calc.evaluationCount).toBe(before);
    });

    it('evaluates a whole batch in one pass', () => {
      const calc = newCalculator();
      put(calc, { A1: '=B1+1', B1: '=C1+1', C1: '=D1+1' });

      const before = calc.evaluationCount;
      put(calc, { D1: '1', E1: '=A1' }); // D1 feeds the whole chain; E1 reads its end
      expect(calc.evaluationCount - before).toBe(4); // C1, B1, A1, E1
      expect(shown(calc, 'E1')).toBe('4');
    });
  });

  describe('updates for a consumer that keeps its own copy of the displays', () => {
    const at = (address: string): number => {
      const position = tryParseCellAddress(address) as { row: number; col: number };
      return position.row * 16_384 + position.col;
    };

    it('lists a new formula and everything it changes', () => {
      const calc = newCalculator();
      expect(calc.applyChanges([{ row: 0, col: 0, raw: '=5+3' }])).toEqual([[at('A1'), '8']]);

      const updates = calc.applyChanges([
        { row: 0, col: 1, raw: '=A1*2' },
        { row: 0, col: 2, raw: '=A1+B1' },
      ]);
      expect(updates).toEqual(expect.arrayContaining([[at('B1'), '16'], [at('C1'), '24']]));
      expect(updates).toHaveLength(2);
    });

    it('lists only displays that actually changed', () => {
      const calc = newCalculator();
      put(calc, { A1: '3', B1: '=A1*0', C1: '=A1+1' });

      // B1 stays 0 however A1 changes, so only C1 has news.
      expect(calc.applyChanges([{ row: 0, col: 0, raw: '9' }])).toEqual([[at('C1'), '10']]);
    });

    it('lists nothing for a cell no formula reads', () => {
      const calc = newCalculator();
      put(calc, { A1: '=1+1' });
      expect(calc.applyChanges([{ row: 5, col: 5, raw: 'hello' }])).toEqual([]);
    });

    it('reports null when a formula cell stops being a formula, or is cleared', () => {
      const calc = newCalculator();
      put(calc, { A1: '=1+1', A2: '=2+2' });

      expect(calc.applyChanges([{ row: 0, col: 0, raw: 'now text' }])).toEqual([[at('A1'), null]]);
      expect(calc.applyChanges([{ row: 1, col: 0, raw: null }])).toEqual([[at('A2'), null]]);
    });

    it('reports #CYCLE! and then the recovered value', () => {
      const calc = newCalculator();
      put(calc, { A1: '=B1', B1: '=A1' });

      const recovered = calc.applyChanges([{ row: 0, col: 1, raw: '4' }]); // B1 becomes the constant 4
      // B1 became the constant 4 (formula display dropped), and A1 now reads it.
      expect(recovered).toEqual(expect.arrayContaining([[at('B1'), null], [at('A1'), '4']]));
    });

    it('reports every formula again when the sheet size changes what they can read', () => {
      const calc = newCalculator(10, 3);
      put(calc, { B1: '=D1' });
      expect(calc.setDimensions(10, 5)).toEqual([[at('B1'), '0']]);
      expect(calc.setDimensions(10, 5)).toEqual([]);
    });
  });

  describe('at scale', () => {
    it('follows a chain of 100,000 dependent cells without overflowing the stack', () => {
      const calc = newCalculator();
      const changes: RawChange[] = [{ row: 0, col: 0, raw: '1' }];
      for (let row = 1; row < 100_000; row++) changes.push({ row, col: 0, raw: `=A${row}+1` });
      calc.applyChanges(changes);

      expect(calc.formulaDisplayAt(99_999, 0)).toBe('100000');

      calc.applyChanges([{ row: 0, col: 0, raw: '11' }]);
      expect(calc.formulaDisplayAt(99_999, 0)).toBe('100010');
    });

    it('updates 10,000 formulas that all read one cell', () => {
      const calc = newCalculator();
      const changes: RawChange[] = [{ row: 0, col: 0, raw: '1' }];
      for (let row = 0; row < 10_000; row++) changes.push({ row, col: 1, raw: '=A1*2' });
      calc.applyChanges(changes);

      const before = calc.evaluationCount;
      calc.applyChanges([{ row: 0, col: 0, raw: '21' }]);

      expect(calc.evaluationCount - before).toBe(10_000);
      expect(calc.formulaDisplayAt(0, 1)).toBe('42');
      expect(calc.formulaDisplayAt(9_999, 1)).toBe('42');
    });

    it('handles a 100,000 cell cycle without overflowing the stack', () => {
      const calc = newCalculator();
      const changes: RawChange[] = [];
      for (let row = 0; row < 100_000; row++) changes.push({ row, col: 0, raw: `=A${(row + 1) % 100_000 + 1}` });
      calc.applyChanges(changes);

      expect(calc.formulaDisplayAt(0, 0)).toBe('#CYCLE!');
      expect(calc.formulaDisplayAt(99_999, 0)).toBe('#CYCLE!');
    });
  });
});

// ---- Property test: incremental recalculation must equal recalculating from scratch -----------

const ROWS = 6;
const COLS = 4;
const CELLS = ROWS * COLS;

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random cell: mostly formulas, and mostly reading cells that come earlier, so most sheets are
 * acyclic. One reference in six can point anywhere, which now and then closes a cycle.
 */
function randomRaw(random: () => number, self: number): string | null {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const ref = (): string => {
    const index = self > 0 && random() < 0.85 ? Math.floor(random() * self) : Math.floor(random() * CELLS);
    return cellAddress(Math.floor(index / COLS), index % COLS);
  };
  const range = (): string => `${ref()}:${ref()}`;

  const roll = random();
  if (roll < 0.12) return null;
  if (roll < 0.3) return String(Math.floor(random() * 20) - 5);
  if (roll < 0.36) return pick(['hello', 'x', 'TRUE', '2.5']);

  return pick([
    () => `=${ref()}+${ref()}`,
    () => `=${ref()}*2`,
    () => `=SUM(${range()})`,
    () => `=IF(${ref()}>3,${ref()},${ref()})`,
    () => `=${ref()}&"x"`,
    () => `=ROUND(${ref()}/3,1)`,
    () => `=-${ref()}`,
    () => `=COUNT(${range()})`,
    () => `=MAX(${ref()},${ref()},5)`,
    () => `=1/${ref()}`,
    () => `=${ref()}`,
    () => `=AVERAGE(${range()})`,
    () => '=1+',
  ])();
}

/**
 * The reference answer: a deliberately different implementation. Plain recursion with memoizing,
 * every cell computed from scratch, cycles found by noticing a cell that is already being
 * computed. Only sheets this small are safe for recursion; the real calculator has no such limit.
 */
function oracle(raws: readonly (string | null)[]): string[] {
  const memo = new Map<number, { value: FormulaValue; cyclic: boolean }>();
  const visiting = new Set<number>();

  const reader = {
    dimensions: { rows: ROWS, cols: COLS },
    getValue: (row: number, col: number): FormulaValue => resolve(row * COLS + col).value,
  };

  function dependenciesOf(ast: Expr): Set<number> {
    const found = new Set<number>();
    const inSheet = (cell: CellRef): boolean => cell.row < ROWS && cell.col < COLS;
    const walk = (node: Expr): void => {
      switch (node.kind) {
        case 'cell':
          if (inSheet(node)) found.add(node.row * COLS + node.col);
          break;
        case 'range':
          if (inSheet(node.bottomRight)) {
            for (let r = node.topLeft.row; r <= node.bottomRight.row; r++) {
              for (let c = node.topLeft.col; c <= node.bottomRight.col; c++) found.add(r * COLS + c);
            }
          }
          break;
        case 'negate':
          walk(node.operand);
          break;
        case 'binary':
          walk(node.left);
          walk(node.right);
          break;
        case 'call':
          node.args.forEach(walk);
          break;
        default:
          break;
      }
    };
    walk(ast);
    return found;
  }

  function resolve(index: number): { value: FormulaValue; cyclic: boolean } {
    const known = memo.get(index);
    if (known) return known;

    const raw = raws[index];
    if (raw === null || raw === '') return { value: valueFromRaw(null), cyclic: false };
    if (raw.charAt(0) !== '=') return { value: valueFromRaw(raw), cyclic: false };

    if (visiting.has(index)) return { value: errorValue('#CYCLE!'), cyclic: true };
    visiting.add(index);

    let result: { value: FormulaValue; cyclic: boolean };
    try {
      const ast = parseFormula(raw);
      let cyclic = false;
      for (const dependency of dependenciesOf(ast)) if (resolve(dependency).cyclic) cyclic = true;
      result = cyclic
        ? { value: errorValue('#CYCLE!'), cyclic: true }
        : { value: evaluateExpr(ast, reader), cyclic: false };
    } catch (error) {
      if (!(error instanceof FormulaSyntaxError)) throw error;
      result = { value: errorValue('#ERROR!'), cyclic: false };
    }

    visiting.delete(index);
    memo.set(index, result);
    return result;
  }

  return raws.map((raw, index) => {
    if (raw === null || raw === '') return '';
    return raw.charAt(0) === '=' ? displayString(resolve(index).value) : raw;
  });
}

function displays(calc: SheetCalculator, raws: readonly (string | null)[]): string[] {
  return raws.map((raw, index) => {
    const row = Math.floor(index / COLS);
    const col = index % COLS;
    return calc.formulaDisplayAt(row, col) ?? raw ?? '';
  });
}

describe('SheetCalculator property test', () => {
  it('matches a from-scratch recalculation after every edit, on random sheets with cycles', () => {
    let checked = 0;
    let sheetsWithCycles = 0;

    for (let seed = 1; seed <= 60; seed++) {
      const random = mulberry32(seed * 7919);
      const raws: (string | null)[] = Array(CELLS).fill(null);
      const incremental = newCalculator(ROWS, COLS);
      // A consumer that never looks at the calculator, only at the updates it is sent.
      const mirror = new Map<number, string>();
      let sawCycle = false;

      for (let step = 0; step < 60; step++) {
        // Usually one edit; sometimes a small batch, like a paste or a merge of remote ops.
        const edits = random() < 0.2 ? 1 + Math.floor(random() * 4) : 1;
        const changes: RawChange[] = [];
        for (let e = 0; e < edits; e++) {
          const index = Math.floor(random() * CELLS);
          raws[index] = randomRaw(random, index);
          changes.push({ row: Math.floor(index / COLS), col: index % COLS, raw: raws[index] });
        }
        for (const [key, display] of incremental.applyChanges(changes)) {
          if (display === null) mirror.delete(key);
          else mirror.set(key, display);
        }

        const expected = oracle(raws);
        expect(displays(incremental, raws), `seed ${seed}, step ${step}`).toEqual(expected);

        // The updates alone must be enough to rebuild every formula's display.
        const fromUpdates = raws.map((raw, index) => {
          const key = Math.floor(index / COLS) * 16_384 + (index % COLS);
          return raw !== null && raw.charAt(0) === '=' ? (mirror.get(key) ?? '(missing)') : raw ?? '';
        });
        expect(fromUpdates, `updates, seed ${seed}, step ${step}`).toEqual(expected);
        sawCycle ||= expected.includes('#CYCLE!');

        // Recalculating everything in one batch on a fresh calculator must agree too.
        if (step % 10 === 9) {
          const fresh = newCalculator(ROWS, COLS);
          fresh.applyChanges(
            raws.map((raw, index) => ({ row: Math.floor(index / COLS), col: index % COLS, raw })),
          );
          expect(displays(fresh, raws), `fresh, seed ${seed}, step ${step}`).toEqual(expected);
        }
        checked++;
      }
      if (sawCycle) sheetsWithCycles++;
    }

    // Guard the test itself: it must actually have exercised cycles, or it proves little.
    expect(checked).toBe(3_600);
    expect(sheetsWithCycles).toBeGreaterThan(5);
  });
});
