import vectorFile from '../../../../spec/fractional-index-vectors.json';
import { between, compareKeys, DIGITS, forBaseRow } from './fractional-index';

interface Vectors {
  readonly between: readonly { before: string | null; after: string | null; expected: string }[];
  readonly invalid: readonly { before: string | null; after: string | null }[];
  readonly baseRows: readonly { index: number; expected: string }[];
}

const vectors = vectorFile as unknown as Vectors;

/** Small seeded PRNG so the property tests are reproducible. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomKey(random: () => number): string {
  const length = 1 + Math.floor(random() * 8);
  let key = '';
  for (let i = 0; i < length - 1; i++) key += DIGITS.charAt(Math.floor(random() * DIGITS.length));
  return key + DIGITS.charAt(1 + Math.floor(random() * (DIGITS.length - 1))); // never ends in "0"
}

describe('fractional index (shared vectors, also run by the C# suite)', () => {
  it.each(vectors.between.map((v) => [`${v.before} .. ${v.after}`, v] as const))('between %s', (_name, v) => {
    expect(between(v.before, v.after)).toBe(v.expected);
  });

  it.each(vectors.invalid.map((v) => [`${v.before} .. ${v.after}`, v] as const))('rejects %s', (_name, v) => {
    expect(() => between(v.before, v.after)).toThrow();
  });

  it.each(vectors.baseRows.map((v) => [v.index, v] as const))('base row %i', (_index, v) => {
    expect(forBaseRow(v.index)).toBe(v.expected);
  });
});

describe('fractional index properties', () => {
  it('lands strictly between two random keys', () => {
    const random = mulberry32(20260924);
    for (let i = 0; i < 5_000; i++) {
      const x = randomKey(random);
      const y = randomKey(random);
      if (x === y) continue;
      const [low, high] = compareKeys(x, y) < 0 ? [x, y] : [y, x];

      const mid = between(low, high);

      expect(compareKeys(low, mid)).toBeLessThan(0);
      expect(compareKeys(mid, high)).toBeLessThan(0);
      expect(mid.endsWith('0')).toBe(false);
    }
  });

  it('keeps every key unique and in order across repeated inserts at random positions', () => {
    const random = mulberry32(7);
    for (let run = 0; run < 30; run++) {
      const keys: string[] = [];
      for (let i = 0; i < 300; i++) {
        const at = Math.floor(random() * (keys.length + 1));
        keys.splice(at, 0, between(at === 0 ? null : keys[at - 1], at === keys.length ? null : keys[at]));
      }
      expect(new Set(keys).size).toBe(keys.length);
      for (let i = 1; i < keys.length; i++) expect(compareKeys(keys[i - 1], keys[i])).toBeLessThan(0);
    }
  });

  it('leaves room between neighbouring base rows', () => {
    for (let i = 0; i < 99_999; i += 997) {
      const a = forBaseRow(i);
      const b = forBaseRow(i + 1);
      const mid = between(a, b);
      expect(compareKeys(a, mid)).toBeLessThan(0);
      expect(compareKeys(mid, b)).toBeLessThan(0);
    }
  });

  it('grows slowly when inserting at the same spot forever', () => {
    const left = forBaseRow(0);
    let key = forBaseRow(1);
    for (let i = 0; i < 500; i++) key = between(left, key);
    expect(key.length).toBeLessThan(120);
  });
});
