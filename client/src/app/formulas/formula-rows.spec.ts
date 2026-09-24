import { RowOrder } from '../rows/row-order';
import { toDisplayFormula, toStoredFormula } from './formula-rows';

const id = (n: number): string => n.toString(16).padStart(32, '0');

function withRowInsertedAt(order: RowOrder, index: number, rowId: string): void {
  order.insert(rowId, order.keysForInsert(index, 1)[0]);
}

describe('toStoredFormula', () => {
  const order = new RowOrder(100);

  it('names each row a formula reads by its id', () => {
    expect(toStoredFormula('=A1', order)).toBe('=A_b0');
    expect(toStoredFormula('=A5+B7', order)).toBe('=A_b4+B_b6');
    expect(toStoredFormula('=SUM(A1:C10)', order)).toBe('=SUM(A_b0:C_b9)');
  });

  it('keeps the column letters as typed', () => {
    expect(toStoredFormula('=a1+ab2', order)).toBe('=a_b0+ab_b1');
  });

  it('leaves everything else in the formula alone', () => {
    expect(toStoredFormula('= A1 * 2 + IF(B2>0, "A1 stays", "x")', order)).toBe(
      '= A_b0 * 2 + IF(B_b1>0, "A1 stays", "x")',
    );
    expect(toStoredFormula('=LOG10(A1)+TAX', order)).toBe('=LOG10(A_b0)+TAX'); // a function and a name are not cells
  });

  it('passes through text that is not a formula', () => {
    expect(toStoredFormula('A1', order)).toBe('A1');
    expect(toStoredFormula('', order)).toBe('');
    expect(toStoredFormula('hello =A1', order)).toBe('hello =A1');
  });

  it('leaves a reference beyond the last row as typed, since there is no row to follow', () => {
    expect(toStoredFormula('=A101+A100', order)).toBe('=A101+A_b99');
  });

  it('leaves text that does not tokenize exactly as typed', () => {
    expect(toStoredFormula('=A1+"unterminated', order)).toBe('=A1+"unterminated');
    expect(toStoredFormula('=A1 # 2', order)).toBe('=A1 # 2');
  });

  it('names an inserted row by its own id', () => {
    const o = new RowOrder(10);
    withRowInsertedAt(o, 2, id(7)); // now row 3 (index 2) is the new one
    expect(toStoredFormula('=A3', o)).toBe(`=A_${id(7)}`);
    expect(toStoredFormula('=A4', o)).toBe('=A_b2');
  });
});

describe('toDisplayFormula', () => {
  it('turns ids back into numbers', () => {
    const order = new RowOrder(100);
    expect(toDisplayFormula('=A_b0+B_b6', order)).toBe('=A1+B7');
    expect(toDisplayFormula('=SUM(A_b0:C_b9)', order)).toBe('=SUM(A1:C10)');
  });

  it('is what toStoredFormula undoes, for any formula', () => {
    const order = new RowOrder(100);
    for (const text of ['=A1', '=A5+B7', '=SUM(A1:C10)*2', '= A1 * 2 + IF(B2>0, "A1 stays", "x")', '=A101', '=1+1', '=LOG10(A1)']) {
      expect(toDisplayFormula(toStoredFormula(text, order), order)).toBe(text);
    }
  });

  it('leaves ordinary names, numbers and text alone', () => {
    const order = new RowOrder(100);
    expect(toDisplayFormula('=TAX*2', order)).toBe('=TAX*2');
    expect(toDisplayFormula('="A_b0"', order)).toBe('="A_b0"'); // inside a string
    expect(toDisplayFormula('plain A_b0', order)).toBe('plain A_b0');
  });

  it('shows a row it has not heard of as a reference past the end', () => {
    const order = new RowOrder(100);
    expect(toDisplayFormula(`=A_${id(9)}`, order)).toBe('=A101');
  });
});

describe('formulas follow the row', () => {
  it('reads the same cells after rows are inserted above and between them', () => {
    const order = new RowOrder(20);
    const stored = toStoredFormula('=A5+SUM(B3:B8)', order);

    withRowInsertedAt(order, 0, id(1)); // above everything: every number moves down one
    expect(toDisplayFormula(stored, order)).toBe('=A6+SUM(B4:B9)');

    withRowInsertedAt(order, 6, id(2)); // between B4 and B9's rows: the range grows, A6 does not
    expect(toDisplayFormula(stored, order)).toBe('=A6+SUM(B4:B10)');
  });

  it('is unchanged by rows inserted below everything it reads', () => {
    const order = new RowOrder(20);
    const stored = toStoredFormula('=A2+B3', order);
    withRowInsertedAt(order, 15, id(1));
    expect(toDisplayFormula(stored, order)).toBe('=A2+B3');
  });

  it('gives every replica the same reading, whatever order the rows arrived in', () => {
    const rows = [id(1), id(2), id(3)];
    const build = (arrival: string[]): RowOrder => {
      const order = new RowOrder(20);
      const keys = new Map(rows.map((rowId, i) => [rowId, new RowOrder(20).keysForInsert(4 + i, 1)[0]]));
      for (const rowId of arrival) order.insert(rowId, keys.get(rowId) as string);
      return order;
    };

    const stored = toStoredFormula('=A5+A9', new RowOrder(20));
    const one = toDisplayFormula(stored, build(rows));
    const other = toDisplayFormula(stored, build([...rows].reverse()));

    expect(other).toBe(one);
  });
});
