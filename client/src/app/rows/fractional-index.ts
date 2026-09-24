/**
 * Keys that sort between any two neighbours, so a row can be inserted anywhere without renumbering
 * the rows around it. Mirrors server/src/GridSync.Core/Rows/FractionalIndex.cs: read the long
 * comment there for the idea. In short, a key is a string of base-62 digits ("0-9A-Za-z", which is
 * also their ASCII order) read as a fraction, it never ends in "0", and plain string comparison
 * orders keys. Both implementations must give identical keys; spec/fractional-index-vectors.json is
 * run by both test suites.
 */
export const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const BASE = 62;
const BASE_ROW_WIDTH = 4;

/** Ordinal comparison: UTF-16 code unit order, which for these ASCII keys is the order that matters. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A key strictly between two others. Null or empty `before` means "before everything"; null `after` means "after everything". */
export function between(before: string | null, after: string | null): string {
  const start = before ?? '';
  validate(start, 'before', true);
  if (after !== null) validate(after, 'after', false);

  if (after !== null && compareKeys(start, after) >= 0) throw new Error(`'${start}' must sort before '${after}'.`);

  return midpoint(start, after);
}

/**
 * The key of the Nth row a sheet starts with. Initial rows are implicit, so their keys are
 * computed, not stored: the index in base 62, padded to a fixed width so they sort in index
 * order, plus a "V" so the key never ends in "0" and there is room between neighbouring rows.
 */
export function forBaseRow(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error('A row index must be a non-negative integer.');

  const digits: string[] = [];
  let rest = index;
  for (let i = 0; i < BASE_ROW_WIDTH; i++) {
    digits.unshift(DIGITS.charAt(rest % BASE));
    rest = Math.floor(rest / BASE);
  }

  if (rest !== 0) throw new Error('Too many rows for a four digit key.');
  return digits.join('') + 'V';
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Keys that share a prefix share it in the answer. A key shorter than the prefix counts as padded with zeros.
    let n = 0;
    while (n < b.length && (n < a.length ? a.charAt(n) : '0') === b.charAt(n)) n++;
    if (n > 0) return b.substring(0, n) + midpoint(n < a.length ? a.substring(n) : '', b.substring(n));
  }

  const digitA = a.length > 0 ? DIGITS.indexOf(a.charAt(0)) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b.charAt(0)) : BASE;

  if (digitB - digitA > 1) return DIGITS.charAt(Math.floor((digitA + digitB + 1) / 2));

  if (b !== null && b.length > 1) return b.substring(0, 1);
  return DIGITS.charAt(digitA) + midpoint(a.length > 0 ? a.substring(1) : '', null);
}

function validate(key: string, name: string, allowEmpty: boolean): void {
  if (key.length === 0) {
    if (allowEmpty) return;
    throw new Error(`${name} cannot be empty.`);
  }

  for (const c of key) {
    if (DIGITS.indexOf(c) < 0) throw new Error(`'${key}' has a character outside 0-9A-Za-z.`);
  }

  if (key.charAt(key.length - 1) === '0') throw new Error(`'${key}' ends in 0, which is another spelling of a shorter key.`);
}
