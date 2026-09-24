import { RawChange, SheetCalculator } from './sheet-calculator';

const at = (row: number, col: number, raw: string | null): RawChange => ({ row, col, raw });

function keys(updates: ReturnType<SheetCalculator['reset']>): number[] {
  return updates.map(([key]) => key).sort((a, b) => a - b);
}

describe('SheetCalculator.reset', () => {
  it('replaces the whole sheet with the cells it is given', () => {
    const calc = new SheetCalculator();
    calc.reset(10, 3, [at(0, 0, '4'), at(0, 1, '=A1*2')]);
    expect(calc.formulaDisplayAt(0, 1)).toBe('8');

    // The same two cells after a row was inserted above them: everything is one row down.
    calc.reset(11, 3, [at(1, 0, '4'), at(1, 1, '=A2*2')]);

    expect(calc.formulaDisplayAt(1, 1)).toBe('8');
    expect(calc.formulaDisplayAt(0, 1)).toBeUndefined(); // nothing left at the old position
    expect(calc.getValue(0, 0).kind).toBe('empty');
  });

  it('reports every formula again, even when its value did not change', () => {
    const calc = new SheetCalculator();
    calc.reset(10, 3, [at(0, 0, '4'), at(0, 1, '=A1*2')]);

    const updates = calc.reset(11, 3, [at(1, 0, '4'), at(1, 1, '=A2*2')]);

    expect(updates).toHaveLength(1); // the one formula, at its new position
    expect(updates[0][1]).toBe('8');
  });

  it('forgets cycles, dependencies and errors from before', () => {
    const calc = new SheetCalculator();
    calc.reset(10, 3, [at(0, 0, '=B1'), at(0, 1, '=A1')]);
    expect(calc.formulaDisplayAt(0, 0)).toBe('#CYCLE!');

    calc.reset(10, 3, [at(0, 0, '1'), at(0, 1, '=A1+1')]);

    expect(calc.formulaDisplayAt(0, 1)).toBe('2');
    // An edit afterwards recalculates only what depends on it, so the old graph is really gone.
    calc.applyChanges([at(0, 0, '10')]);
    expect(calc.formulaDisplayAt(0, 1)).toBe('11');
  });

  it('resolves references against the new size', () => {
    const calc = new SheetCalculator();
    calc.reset(5, 3, [at(0, 0, '=A6')]);
    expect(calc.formulaDisplayAt(0, 0)).toBe('#REF!'); // row 6 does not exist in a five row sheet

    calc.reset(6, 3, [at(0, 0, '=A6')]);
    expect(calc.formulaDisplayAt(0, 0)).toBe('0'); // now it does, and is empty
  });

  it('gives the same answers as building the sheet cell by cell', () => {
    const cells = [at(0, 0, '3'), at(1, 0, '4'), at(2, 0, '=A1+A2'), at(2, 1, '=SUM(A1:A3)'), at(3, 1, '=B3*2')];

    const built = new SheetCalculator();
    built.setDimensions(20, 4);
    built.applyChanges(cells);

    const reset = new SheetCalculator();
    reset.reset(20, 4, cells);

    for (const { row, col } of cells) expect(reset.formulaDisplayAt(row, col)).toBe(built.formulaDisplayAt(row, col));
    expect(keys(reset.reset(20, 4, cells))).toHaveLength(3);
  });
});
