import { between, forBaseRow } from '../rows/fractional-index';
import { RowOrder } from '../rows/row-order';
import { identityFromNodeId } from '../sync/identity';
import { describeStep } from './describe-step';
import type { HistoryOp, HistoryStep } from './history-api';
import { HistoryGridData } from './history-grid-data';

const INSERTED = '0123456789abcdef0123456789abcdef';
const NODE = '0a1b2c3d4e5f6071';
const ts = (wallMs: number) => ({ wallMs, counter: 0, nodeId: NODE });

/** A sheet of 3 rows and 2 columns: A1 = 2, A2 = 3, A3 = A1 + A2, with the formula stored by row id. */
function step(overrides: Partial<HistoryStep> = {}): HistoryStep {
  return {
    step: 3,
    count: 3,
    rows: 3,
    cols: 2,
    insertedRows: [],
    cells: [
      { rowId: 'b0', col: 0, value: '2', ts: ts(1) },
      { rowId: 'b1', col: 0, value: '3', ts: ts(2) },
      { rowId: 'b2', col: 0, value: '=A_b0+A_b1', ts: ts(3) },
    ],
    op: { kind: 'cell', rowId: 'b2', col: 0, value: '=A_b0+A_b1', ts: ts(3) },
    ...overrides,
  };
}

/** A row inserted between the first two, so every row after the first moves down one. */
const rowBetweenFirstTwo = { rowId: INSERTED, key: between(forBaseRow(0), forBaseRow(1)) };

describe('HistoryGridData', () => {
  it('shows a formula by its computed value and reads it back as typed', () => {
    const data = new HistoryGridData();
    data.load(step());

    expect(data.dims()).toEqual({ rows: 3, cols: 2 });
    expect(data.displayAt(0, 0)).toBe('2');
    expect(data.displayAt(2, 0)).toBe('5');
    expect(data.valueAt(2, 0)).toBe('=A1+A2');
    expect(data.displayAt(1, 1)).toBe('');
  });

  it('keeps a formula pointing at the same rows when a row was inserted above them', () => {
    const data = new HistoryGridData();
    data.load(step({ insertedRows: [rowBetweenFirstTwo] }));

    expect(data.dims().rows).toBe(4);
    expect(data.displayAt(3, 0)).toBe('5'); // the formula row is now fourth
    expect(data.valueAt(3, 0)).toBe('=A1+A3'); // and A2 became A3
    expect(data.displayAt(1, 0)).toBe(''); // the new row is empty
  });

  it('is read-only: the writes do nothing', () => {
    const data = new HistoryGridData();
    data.load(step());

    expect(data.readOnly).toBe(true);
    data.setCell();
    expect(data.insertRows(1)).toBe(1);
    expect(data.dims().rows).toBe(3);
    expect(data.valueAt(0, 0)).toBe('2');
  });

  it('flashes the cell the step changed, in its author ink, and no other', () => {
    const data = new HistoryGridData();
    data.load(step({ insertedRows: [rowBetweenFirstTwo] }));

    expect(data.flashAt(3, 0)).toBe(identityFromNodeId(NODE).color);
    expect(data.flashAt(0, 0)).toBeUndefined();
  });

  it('does not flash after a row insert or at step 0', () => {
    const data = new HistoryGridData();
    const row: HistoryOp = { kind: 'row', rowId: INSERTED, col: 0, value: null, ts: null };
    data.load(step({ insertedRows: [rowBetweenFirstTwo], op: row }));
    expect(data.flashAt(1, 0)).toBeUndefined();

    data.load(step({ step: 0, cells: [], insertedRows: [], op: null }));
    expect(data.flashAt(0, 0)).toBeUndefined();
  });

  it('replaces everything when the next version loads', () => {
    const data = new HistoryGridData();
    data.load(step());
    data.load(step({ step: 0, cells: [], op: null }));

    expect(data.displayAt(0, 0)).toBe('');
    expect(data.displayAt(2, 0)).toBe('');
  });

  it('summarizes a block from the displayed values', () => {
    const data = new HistoryGridData();
    data.load(step());

    expect(data.displaysIn({ top: 0, left: 0, bottom: 2, right: 1 }).filter((v) => v !== '')).toEqual(['2', '3', '5']);
  });
});

describe('describeStep', () => {
  const order = (...inserted: { rowId: string; key: string }[]) => {
    const rows = new RowOrder(3);
    for (const row of inserted) rows.insert(row.rowId, row.key);
    return rows;
  };

  it('says nothing for step 0', () => {
    expect(describeStep(step({ step: 0, op: null }), order())).toBeNull();
  });

  it('names the author, the address and the value', () => {
    const op: HistoryOp = { kind: 'cell', rowId: 'b1', col: 1, value: '1,250', ts: ts(1_700_000_000_000) };
    const d = describeStep(step({ op }), order());

    expect(d?.what).toBe('set B2 to 1,250');
    expect(d?.who).toEqual(identityFromNodeId(NODE));
    expect(d?.at?.getTime()).toBe(1_700_000_000_000);
  });

  it('says cleared for a clear', () => {
    const op: HistoryOp = { kind: 'cell', rowId: 'b0', col: 0, value: null, ts: ts(1) };
    expect(describeStep(step({ op }), order())?.what).toBe('cleared A1');
  });

  it('shows a formula the way it was typed, with this version row numbers', () => {
    const op: HistoryOp = { kind: 'cell', rowId: 'b2', col: 0, value: '=A_b0+A_b1', ts: ts(3) };

    expect(describeStep(step({ op }), order())?.what).toBe('set A3 to =A1+A2');
    expect(describeStep(step({ op }), order(rowBetweenFirstTwo))?.what).toBe('set A4 to =A1+A3');
  });

  it('cuts a long value', () => {
    const op: HistoryOp = { kind: 'cell', rowId: 'b0', col: 0, value: 'x'.repeat(100), ts: ts(1) };
    const what = describeStep(step({ op }), order())?.what ?? '';

    expect(what.endsWith('…')).toBe(true);
    expect(what.length).toBeLessThan(60);
  });

  it('describes a row insert without an author or a time', () => {
    const op: HistoryOp = { kind: 'row', rowId: INSERTED, col: 0, value: null, ts: null };
    const d = describeStep(step({ op }), order(rowBetweenFirstTwo));

    expect(d).toEqual({ who: null, what: 'Row 2 was inserted', at: null });
  });
});
