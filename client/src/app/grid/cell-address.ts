/** 0 -> "A", 25 -> "Z", 26 -> "AA", 701 -> "ZZ", 702 -> "AAA" (bijective base 26, like Excel). */
export function columnName(col: number): string {
  let name = '';
  let n = col + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Zero-based (row, col) to an A1-style address: (11, 1) -> "B12". */
export function cellAddress(row: number, col: number): string {
  return `${columnName(col)}${row + 1}`;
}

/**
 * Splits clipboard text copied from Excel or Google Sheets (tab-separated columns,
 * newline-separated rows) into a 2D array. Quoted multi-line cells aren't handled yet.
 */
export function parseClipboardGrid(text: string): string[][] {
  const trimmed = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (trimmed === '') return [];
  return trimmed.split('\n').map((line) => line.split('\t'));
}
