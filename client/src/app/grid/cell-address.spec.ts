import { cellAddress, columnName, parseClipboardGrid } from './cell-address';

describe('cell addresses', () => {
  it('names columns like a spreadsheet', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
  });

  it('builds A1-style addresses from zero-based positions', () => {
    expect(cellAddress(0, 0)).toBe('A1');
    expect(cellAddress(11, 1)).toBe('B12');
  });
});

describe('parseClipboardGrid', () => {
  it('splits tab-separated rows copied from Excel or Sheets', () => {
    expect(parseClipboardGrid('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('returns nothing for empty clipboard text', () => {
    expect(parseClipboardGrid('')).toEqual([]);
  });
});
