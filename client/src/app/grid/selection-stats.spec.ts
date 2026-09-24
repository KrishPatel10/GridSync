import { formatStat, numberOf, summarize } from './selection-stats';

describe('numberOf', () => {
  it('reads plain, signed, decimal and comma-grouped numbers', () => {
    expect(numberOf('42')).toBe(42);
    expect(numberOf('-3.5')).toBe(-3.5);
    expect(numberOf('1,250,000')).toBe(1_250_000);
    expect(numberOf('.5')).toBe(0.5);
  });

  it('reads a percentage as a fraction', () => {
    expect(numberOf('12%')).toBeCloseTo(0.12);
  });

  it('treats text, errors and blanks as not numbers', () => {
    for (const text of ['', 'abc', '12abc', '#DIV/0!', '-', '%', '1,2', '1e5']) expect(numberOf(text)).toBeNull();
  });
});

describe('summarize', () => {
  it('reports nothing for an empty selection', () => {
    expect(summarize([])).toBeNull();
    expect(summarize(['', ''])).toBeNull();
  });

  it('sums, averages and finds the extremes of the numbers', () => {
    expect(summarize(['1', '2', '3', '10'])).toEqual({ count: 4, numbers: 4, sum: 16, average: 4, min: 1, max: 10 });
  });

  it('counts text as filled but leaves it out of the arithmetic', () => {
    const stats = summarize(['4', 'hello', '', '#REF!', '6']);
    expect(stats).toMatchObject({ count: 4, numbers: 2, sum: 10, average: 5, min: 4, max: 6 });
  });

  it('has no average for a selection of only text', () => {
    expect(summarize(['a', 'b'])).toMatchObject({ count: 2, numbers: 0, sum: 0, average: 0 });
  });

  it('handles negatives', () => {
    expect(summarize(['-5', '3'])).toMatchObject({ sum: -2, min: -5, max: 3 });
  });
});

describe('formatStat', () => {
  it('hides floating point noise', () => {
    expect(formatStat(0.1 + 0.2)).toBe('0.3');
  });

  it('groups thousands and keeps decimals', () => {
    expect(formatStat(1_234_567.891)).toBe('1,234,567.891');
    expect(formatStat(-2)).toBe('-2');
  });
});
