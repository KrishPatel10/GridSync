export interface SelectionStats {
  /** Cells that hold anything: numbers, text, formula results, errors. */
  readonly count: number;
  /** Of those, the ones that read as numbers. */
  readonly numbers: number;
  readonly sum: number;
  readonly average: number;
  readonly min: number;
  readonly max: number;
}

/** The same shapes the grid right-aligns: 42, -3.5, 1,250,000, 12%. */
const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/;

/** A cell's number, or null if it is text. "12%" is 0.12 and "1,250" is 1250, as in Excel. */
export function numberOf(text: string): number | null {
  if (!/\d/.test(text) || !NUMBER.test(text)) return null;
  const percent = text.endsWith('%');
  const value = Number(text.replace(/,/g, '').replace(/%$/, ''));
  if (!Number.isFinite(value)) return null;
  return percent ? value / 100 : value;
}

/**
 * What Excel's status bar shows for a selection. Takes the displayed text of the non-empty cells
 * only (empty ones never count), so a select-all over a mostly empty sheet costs what is filled, not
 * what is selected. Returns null when there is nothing to report.
 */
export function summarize(values: Iterable<string>): SelectionStats | null {
  let count = 0;
  let numbers = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  for (const text of values) {
    if (text === '') continue;
    count++;
    const n = numberOf(text);
    if (n === null) continue;
    numbers++;
    sum += n;
    if (n < min) min = n;
    if (n > max) max = n;
  }

  if (count === 0) return null;
  return { count, numbers, sum, average: numbers === 0 ? 0 : sum / numbers, min, max };
}

/** Up to 10 significant digits and no float noise (0.1 + 0.2 shows 0.3), with thousands separators. */
export function formatStat(value: number): string {
  return Number(value.toPrecision(10)).toLocaleString('en-US', { maximumFractionDigits: 10 });
}
