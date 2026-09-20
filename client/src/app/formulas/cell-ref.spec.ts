import { cellAddress, columnName } from '../grid/cell-address';
import { tryParseCellAddress } from './cell-ref';

describe('tryParseCellAddress', () => {
  it.each([
    ['A1', 0, 0],
    ['b2', 1, 1],
    ['Z100', 99, 25],
    ['AA1', 0, 26],
    ['XFD1048576', 1_048_575, 16_383],
  ])('parses %s case-insensitively', (text, row, col) => {
    expect(tryParseCellAddress(text)).toEqual({ row, col });
  });

  it.each([
    '',
    'A',
    '1',
    'A0',
    'A01',
    '1A',
    'A1B',
    'ABCD1',
    'A1000000000', // ten digits
    'A-1',
    'É1',
  ])('rejects %j', (text) => {
    expect(tryParseCellAddress(text)).toBeNull();
  });

  it('round-trips with the existing cellAddress formatter', () => {
    for (const [row, col] of [[0, 0], [9, 25], [99_999, 26], [5, 701]]) {
      expect(tryParseCellAddress(cellAddress(row, col))).toEqual({ row, col });
    }
  });

  it('agrees with the C# column naming', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
  });
});
