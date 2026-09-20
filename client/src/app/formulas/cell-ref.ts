import { isAsciiLetter } from './chars';

/** Excel's widest column is "XFD" (3 letters). Longer words are names, not cells. */
const MAX_COLUMN_LETTERS = 3;

/** Nine digits always fit in an int32, matching the C# side, so the row can never overflow. */
const MAX_ROW_DIGITS = 9;

export interface CellPosition {
  readonly row: number;
  readonly col: number;
}

/**
 * Parses "A1", "b12", "XFD1048576" into zero-based (row, col). Rejects "A0", "1A", "A1B", and
 * anything with more than three letters. Says nothing about whether the cell is inside the sheet:
 * that is the evaluator's job, and it reports #REF!. Mirrors CellAddress.TryParse in C#.
 * (columnName and cellAddress, the reverse direction, live in grid/cell-address.ts.)
 */
export function tryParseCellAddress(text: string): CellPosition | null {
  let letters = 0;
  let column = 0;
  while (letters < text.length && isAsciiLetter(text.charAt(letters))) {
    if (letters === MAX_COLUMN_LETTERS) return null;
    column = column * 26 + ((text.charCodeAt(letters) | 0x20) - 97 + 1);
    letters++;
  }

  const digits = text.length - letters;
  if (letters === 0 || digits === 0 || digits > MAX_ROW_DIGITS || text.charAt(letters) === '0') return null;

  let rowNumber = 0;
  for (let i = letters; i < text.length; i++) {
    const d = text.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return null;
    rowNumber = rowNumber * 10 + d;
  }

  return { row: rowNumber - 1, col: column - 1 };
}
