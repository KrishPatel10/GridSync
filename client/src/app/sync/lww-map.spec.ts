import { CellWrite, LwwCellMap } from './lww-map';

const op = (row: number, col: number, value: string | null, wallMs: number, counter = 0, nodeId = 'n'): CellWrite => ({
  row,
  col,
  value,
  ts: { wallMs, counter, nodeId },
});

/** Small seeded PRNG so the property test is reproducible. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('LwwCellMap', () => {
  it('lets the newer write win and ignores a late older one', () => {
    const map = new LwwCellMap();
    expect(map.apply(op(0, 0, 'new', 2))).toBe(true);
    expect(map.apply(op(0, 0, 'old', 1))).toBe(false);
    expect(map.get(0, 0)?.value).toBe('new');
  });

  it('treats a repeated op as a no-op', () => {
    const map = new LwwCellMap();
    const edit = op(1, 1, 'x', 5);
    expect(map.apply(edit)).toBe(true);
    expect(map.apply(edit)).toBe(false);
  });

  it('keeps a cleared cell as a tombstone so an older value cannot come back', () => {
    const map = new LwwCellMap();
    map.apply(op(2, 2, 'hello', 1));
    map.apply(op(2, 2, null, 3));
    expect(map.apply(op(2, 2, 'hello again', 2))).toBe(false);
    expect(map.get(2, 2)?.value).toBeNull();
    expect(map.filledCount).toBe(0);
  });

  it('counts filled cells through set, overwrite, and clear', () => {
    const map = new LwwCellMap();
    map.apply(op(0, 0, 'a', 1));
    map.apply(op(0, 1, 'b', 1));
    map.apply(op(0, 0, 'a2', 2));
    map.apply(op(0, 1, null, 2));
    expect(map.filledCount).toBe(1);
  });

  it('converges no matter what order ops arrive in', () => {
    const random = mulberry32(20260920);
    const nodes = ['alice', 'bob', 'carol'];
    const ops: CellWrite[] = [];
    for (let i = 0; i < 2_000; i++) {
      const value = random() < 0.2 ? null : `v${i}`;
      ops.push(op(Math.floor(random() * 10), Math.floor(random() * 3), value, 1 + Math.floor(random() * 200), Math.floor(random() * 3), nodes[Math.floor(random() * 3)]));
    }
    ops.push(...ops.slice(0, 300)); // duplicates, as if resent after a reconnect

    const render = (map: LwwCellMap) =>
      map
        .toOps()
        .sort((a, b) => a.row - b.row || a.col - b.col)
        .map((o) => `${o.row},${o.col}=${o.value}@${o.ts.wallMs}:${o.ts.counter}:${o.ts.nodeId}`)
        .join('\n');

    let expected: string | undefined;
    for (let replica = 0; replica < 25; replica++) {
      const shuffled = ops.map((o) => [random(), o] as const).sort((a, b) => a[0] - b[0]).map(([, o]) => o);
      const map = new LwwCellMap();
      shuffled.forEach((o) => map.apply(o));
      const state = render(map);
      expected ??= state;
      expect(state).toBe(expected);
    }
  });
});
