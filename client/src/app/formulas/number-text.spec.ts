import { decimalRound } from './decimal-round';
import { displayString, numberValue, valueFromRaw } from './formula-value';
import { numberToText, tryParseNumber } from './number-text';

describe('tryParseNumber', () => {
  it.each([
    ['5', 5],
    ['-5', -5],
    ['+5', 5],
    ['3.14', 3.14],
    ['.5', 0.5],
    ['5.', 5],
    ['-.5', -0.5],
    ['1e3', 1000],
    ['1E+3', 1000],
    ['2.5e-2', 0.025],
    ['007', 7],
  ])('parses %s', (text, expected) => {
    expect(tryParseNumber(text)).toBe(expected);
  });

  it.each([
    '',
    '.',
    '-',
    'e5',
    '1e',
    '1e+',
    '1.2.3',
    ' 5',
    '5 ',
    '1,000',
    '5x',
    '--5',
    'Infinity',
    'NaN',
    '0x10',
    '1e400', // too big for a double
    '１２', // full-width digits are not ASCII digits
  ])('rejects %j', (text) => {
    expect(tryParseNumber(text)).toBeNull();
  });
});

describe('numberToText', () => {
  // Same table as NumberTextTests.cs. If a row differs between the two, the engines disagree.
  it.each([
    [0, '0'],
    [1, '1'],
    [-1, '-1'],
    [100, '100'],
    [123.456, '123.456'],
    [0.5, '0.5'],
    [-0.25, '-0.25'],
    [0.1 + 0.2, '0.3'],
    [1 / 3, '0.333333333333333'],
    [2 / 3, '0.666666666666667'],
    [123456789012345, '123456789012345'],
    [1e14, '100000000000000'],
    [1e15, '1E+15'],
    [1.5e15, '1.5E+15'],
    [-2.5e20, '-2.5E+20'],
    [1e-5, '0.00001'],
    [1.5e-5, '0.000015'],
    [1e-6, '1E-06'],
    [1.5e-7, '1.5E-07'],
    [1e-100, '1E-100'],
    [1e100, '1E+100'],
    [Number.MAX_VALUE, '1.79769313486232E+308'],
    [Number.MIN_VALUE, '4.94065645841247E-324'],
  ])('formats %d with fifteen significant digits as %s', (value, expected) => {
    expect(numberToText(value)).toBe(expected);
  });
});

describe('decimalRound', () => {
  it.each([
    [2.675, 2, 2.68],
    [2.5, 0, 3],
    [-2.5, 0, -3],
    [0.5, 0, 1],
    [0.49, 0, 0],
    [1234.5678, 2, 1234.57],
    [1234.5678, -3, 1000],
    [1500, -3, 2000],
    [9.995, 2, 10],
    [0.000001234, 8, 0.00000123],
    [12345, 10, 12345],
    [0, 3, 0],
  ])('rounds %d to %i places as %d, half away from zero, on the decimal digits', (value, places, expected) => {
    expect(decimalRound(value, places)).toBe(expected);
  });
});

describe('formula values', () => {
  it.each([
    [null, 'empty'],
    ['', 'empty'],
    ['42', 'number'],
    ['4 2', 'text'],
    ['=1+1', 'text'], // formulas are the caller's business, not valueFromRaw's
  ])('reads raw cell text %j as %s', (raw, kind) => {
    expect(valueFromRaw(raw).kind).toBe(kind);
  });

  it('normalizes negative zero when a number value is created', () => {
    expect(displayString(numberValue(-0))).toBe('0');
    expect(Object.is((numberValue(-0) as { value: number }).value, 0)).toBe(true);
  });
});
