import {
  cellAtPoint,
  isSingleCell,
  rangeContains,
  rangeHeight,
  rangeLabel,
  rangeOf,
  rangeToClipboardText,
  rangeWidth,
} from './selection';

describe('rangeOf', () => {
  it('is the same rectangle whichever corner it was dragged from', () => {
    const expected = { top: 1, left: 2, bottom: 4, right: 5 };
    expect(rangeOf({ row: 1, col: 2 }, { row: 4, col: 5 })).toEqual(expected);
    expect(rangeOf({ row: 4, col: 5 }, { row: 1, col: 2 })).toEqual(expected);
    expect(rangeOf({ row: 1, col: 5 }, { row: 4, col: 2 })).toEqual(expected);
    expect(rangeOf({ row: 4, col: 2 }, { row: 1, col: 5 })).toEqual(expected);
  });

  it('is a single cell when both corners are the same', () => {
    const range = rangeOf({ row: 3, col: 3 }, { row: 3, col: 3 });
    expect(isSingleCell(range)).toBe(true);
    expect(rangeHeight(range)).toBe(1);
    expect(rangeWidth(range)).toBe(1);
  });

  it('is not single when it spans a row or a column', () => {
    expect(isSingleCell(rangeOf({ row: 0, col: 0 }, { row: 0, col: 1 }))).toBe(false);
    expect(isSingleCell(rangeOf({ row: 0, col: 0 }, { row: 1, col: 0 }))).toBe(false);
  });
});

describe('rangeContains', () => {
  const range = rangeOf({ row: 2, col: 1 }, { row: 4, col: 3 });

  it('includes every edge and corner', () => {
    for (const [row, col] of [[2, 1], [2, 3], [4, 1], [4, 3], [3, 2]]) expect(rangeContains(range, row, col)).toBe(true);
  });

  it('excludes cells just outside on each side', () => {
    for (const [row, col] of [[1, 2], [5, 2], [3, 0], [3, 4]]) expect(rangeContains(range, row, col)).toBe(false);
  });
});

describe('rangeLabel', () => {
  it('names a single cell by its address', () => {
    expect(rangeLabel(rangeOf({ row: 0, col: 0 }, { row: 0, col: 0 }))).toBe('A1');
  });

  it('names a block from its top-left to its bottom-right', () => {
    expect(rangeLabel(rangeOf({ row: 4, col: 3 }, { row: 1, col: 1 }))).toBe('B2:D5');
  });

  it('handles columns past Z', () => {
    expect(rangeLabel(rangeOf({ row: 0, col: 0 }, { row: 9, col: 26 }))).toBe('A1:AA10');
  });
});

describe('rangeToClipboardText', () => {
  const cells: Record<string, string> = { '0,0': 'a', '0,1': 'b', '1,0': 'c', '1,1': '=A1+1' };
  const valueAt = (row: number, col: number) => cells[`${row},${col}`] ?? '';

  it('joins columns with tabs and rows with newlines', () => {
    expect(rangeToClipboardText(rangeOf({ row: 0, col: 0 }, { row: 1, col: 1 }), valueAt)).toBe('a\tb\nc\t=A1+1');
  });

  it('keeps empty cells so the shape survives a paste', () => {
    expect(rangeToClipboardText(rangeOf({ row: 0, col: 0 }, { row: 2, col: 2 }), valueAt)).toBe('a\tb\t\nc\t=A1+1\t\n\t\t');
  });

  it('is just the value for one cell', () => {
    expect(rangeToClipboardText(rangeOf({ row: 0, col: 1 }, { row: 0, col: 1 }), valueAt)).toBe('b');
  });
});

describe('cellAtPoint', () => {
  const geometry = { rowHeight: 30, colWidth: 128, headerHeight: 30, rowHeaderWidth: 64 };
  const dims = { rows: 100, cols: 26 };

  it('finds the cell under a point, past the headers', () => {
    expect(cellAtPoint(64, 30, geometry, dims)).toEqual({ row: 0, col: 0 });
    expect(cellAtPoint(64 + 128 * 2 + 5, 30 + 30 * 3 + 5, geometry, dims)).toEqual({ row: 3, col: 2 });
  });

  it('clamps a point over the headers or beyond the top left to the first cell', () => {
    expect(cellAtPoint(0, 0, geometry, dims)).toEqual({ row: 0, col: 0 });
    expect(cellAtPoint(-500, -500, geometry, dims)).toEqual({ row: 0, col: 0 });
  });

  it('clamps a point beyond the bottom right to the last cell', () => {
    expect(cellAtPoint(999_999, 999_999, geometry, dims)).toEqual({ row: 99, col: 25 });
  });

  it('treats the exact boundary between two cells as the later one', () => {
    expect(cellAtPoint(64 + 128, 30, geometry, dims).col).toBe(1);
    expect(cellAtPoint(64, 30 + 30, geometry, dims).row).toBe(1);
  });
});
