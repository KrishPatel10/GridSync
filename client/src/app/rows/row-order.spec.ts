import { compareKeys, forBaseRow } from './fractional-index';
import { baseRowId, InsertedRow, newRowId, parseBaseRowId, RowOrder } from './row-order';

/** Small seeded generator, so a failing case can be replayed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const id = (n: number): string => n.toString(16).padStart(32, '0');

/** The slow, obviously right answer: every row in one list, sorted by (key, id). */
function oracle(baseRows: number, inserted: readonly InsertedRow[]): string[] {
  const all = [
    ...Array.from({ length: baseRows }, (_, i) => ({ id: baseRowId(i), key: forBaseRow(i) })),
    ...inserted.map((r) => ({ id: r.rowId, key: r.key })),
  ];
  all.sort((x, y) => compareKeys(x.key, y.key) || compareKeys(x.id, y.id));
  return all.map((r) => r.id);
}

function order(baseRows: number, inserted: readonly InsertedRow[]): RowOrder {
  const o = new RowOrder(baseRows);
  for (const r of inserted) o.insert(r.rowId, r.key);
  return o;
}

function ids(o: RowOrder): string[] {
  return Array.from({ length: o.count }, (_, i) => o.idAt(i) as string);
}

describe('row ids', () => {
  it('names initial rows b0, b1 and so on, and reads them back', () => {
    expect(baseRowId(12)).toBe('b12');
    expect(parseBaseRowId('b12')).toBe(12);
    expect(parseBaseRowId('b0')).toBe(0);
  });

  it('accepts only the canonical spelling', () => {
    for (const bad of ['b', 'b05', 'b-1', 'B1', 'b1x', '12', id(1)]) expect(parseBaseRowId(bad)).toBeNull();
  });

  it('makes 32 hex digit ids that do not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newRowId()));
    expect(seen.size).toBe(200);
    for (const rowId of seen) expect(rowId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('RowOrder with no inserted rows', () => {
  it('is the initial rows in order', () => {
    const o = new RowOrder(5);
    expect(o.count).toBe(5);
    expect(ids(o)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
    expect(o.indexOf('b3')).toBe(3);
    expect(o.handleAt(3)).toBe(3);
  });

  it('answers out of range questions with -1 and nothing', () => {
    const o = new RowOrder(5);
    expect(o.handleAt(-1)).toBe(-1);
    expect(o.handleAt(5)).toBe(-1);
    expect(o.idAt(5)).toBeUndefined();
    expect(o.indexOf('b5')).toBe(-1);
    expect(o.indexOf(id(1))).toBe(-1);
    expect(o.has('b4')).toBe(true);
    expect(o.has('b5')).toBe(false);
  });

  it('handles the full 100,000 rows without storing them', () => {
    const o = new RowOrder(100_000);
    expect(o.count).toBe(100_000);
    expect(o.idAt(99_999)).toBe('b99999');
    expect(o.indexOf('b54321')).toBe(54_321);
  });
});

describe('RowOrder.insert', () => {
  it('puts a row between the two it was keyed between', () => {
    const o = new RowOrder(5);
    o.insert(id(1), o.keysForInsert(2, 1)[0]);

    expect(o.count).toBe(6);
    expect(ids(o)).toEqual(['b0', 'b1', id(1), 'b2', 'b3', 'b4']);
    expect(o.indexOf(id(1))).toBe(2);
    expect(o.indexOf('b2')).toBe(3); // the row that was at 2 moved down; its id did not change
  });

  it('can add at the very start and the very end', () => {
    const o = new RowOrder(3);
    o.insert(id(1), o.keysForInsert(0, 1)[0]);
    o.insert(id(2), o.keysForInsert(o.count, 1)[0]);

    expect(ids(o)).toEqual([id(1), 'b0', 'b1', 'b2', id(2)]);
  });

  it('ignores a row it already has, and never accepts an initial row id', () => {
    const o = new RowOrder(3);
    expect(o.insert(id(1), 'V5')).toBe(true);
    expect(o.insert(id(1), 'Z')).toBe(false); // first key wins, as on the server
    expect(o.insert('b1', 'V5')).toBe(false);
    expect(o.insertedCount).toBe(1);
    expect(o.inserted()).toEqual([{ rowId: id(1), key: 'V5' }]);
  });

  it('inserts several rows at once in the order asked for', () => {
    const o = new RowOrder(4);
    o.keysForInsert(2, 3).forEach((key, i) => o.insert(id(10 + i), key));

    expect(ids(o)).toEqual(['b0', 'b1', id(10), id(11), id(12), 'b2', 'b3']);
  });

  it('keeps a handle that never changes, however rows move around it', () => {
    const o = new RowOrder(4);
    const before = o.handleOf('b2');
    o.insert(id(1), o.keysForInsert(0, 1)[0]);
    o.insert(id(2), o.keysForInsert(0, 1)[0]);

    expect(o.handleOf('b2')).toBe(before);
    expect(o.indexOfHandle(before)).toBe(4);
    expect(o.idOfHandle(o.handleOf(id(1)))).toBe(id(1));
  });

  it('lets a run of inserts at one spot pile up in order, without renumbering anything', () => {
    const o = new RowOrder(3);
    // each new row goes right after b0, above the previous new row
    for (let i = 0; i < 50; i++) o.insert(id(i + 1), o.keysForInsert(1, 1)[0]);

    expect(o.count).toBe(53);
    expect(o.idAt(0)).toBe('b0');
    expect(o.idAt(1)).toBe(id(50));
    expect(o.idAt(50)).toBe(id(1));
    expect(o.idAt(51)).toBe('b1');
  });
});

describe('two people inserting at the same spot', () => {
  it('give the same key twice, and still agree on one order', () => {
    const key = new RowOrder(5).keysForInsert(2, 1)[0];
    const mine = { rowId: id(1), key };
    const theirs = { rowId: id(2), key };

    const a = order(5, [mine, theirs]);
    const b = order(5, [theirs, mine]);

    expect(ids(a)).toEqual(ids(b));
    expect(ids(a)).toEqual(['b0', 'b1', id(1), id(2), 'b2', 'b3', 'b4']); // tie broken by id
  });

  it('can still insert between the two who tied, by landing after both', () => {
    const key = new RowOrder(5).keysForInsert(2, 1)[0];
    const o = order(5, [
      { rowId: id(1), key },
      { rowId: id(2), key },
    ]);

    // Between the tied rows (index 3) no key fits; the row goes after the pair instead.
    o.insert(id(3), o.keysForInsert(3, 1)[0]);

    expect(ids(o)).toEqual(['b0', 'b1', id(1), id(2), id(3), 'b2', 'b3', 'b4']);
  });
});

describe('RowOrder against the slow oracle, over random histories', () => {
  it('agrees on every position, handle and lookup, and on any arrival order', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const next = random(seed);
      const baseRows = 1 + Math.floor(next() * 12);
      const builder = new RowOrder(baseRows);
      const history: InsertedRow[] = [];

      for (let i = 0; i < 40; i++) {
        const at = Math.floor(next() * (builder.count + 1));
        const count = 1 + Math.floor(next() * 3);
        const keys = builder.keysForInsert(at, count);
        keys.forEach((key, k) => {
          const row = { rowId: id(history.length + 1), key };
          history.push(row);
          builder.insert(row.rowId, row.key);
          // and now and then a concurrent twin: same key, another id, as two people at one spot would make
          if (k === 0 && next() < 0.15) {
            const twin = { rowId: id(1000 + history.length), key };
            history.push(twin);
            builder.insert(twin.rowId, twin.key);
          }
        });
      }

      const expected = oracle(baseRows, history);
      expect(ids(builder)).toEqual(expected);

      // Every replica that saw the same rows agrees, in any order.
      const shuffled = [...history].sort(() => next() - 0.5);
      const other = order(baseRows, shuffled);
      expect(ids(other)).toEqual(expected);

      // Lookups agree in both directions.
      expected.forEach((rowId, index) => {
        expect(builder.idAt(index)).toBe(rowId);
        expect(builder.indexOf(rowId)).toBe(index);
        expect(builder.indexOfHandle(builder.handleAt(index))).toBe(index);
      });
    }
  });

  it('places keysForInsert exactly where asked when no keys tie', () => {
    for (let seed = 100; seed < 130; seed++) {
      const next = random(seed);
      const o = new RowOrder(6);
      for (let i = 0; i < 30; i++) {
        const at = Math.floor(next() * (o.count + 1));
        const before = ids(o);
        const newId = id(i + 1);
        o.insert(newId, o.keysForInsert(at, 1)[0]);
        expect(ids(o)).toEqual([...before.slice(0, at), newId, ...before.slice(at)]);
      }
    }
  });
});

describe('RowOrder.layout', () => {
  it('keeps answering for the order it was taken from after rows are inserted', () => {
    const o = new RowOrder(4);
    const snapshot = o.layout();

    o.insert(id(1), o.keysForInsert(0, 1)[0]);

    expect(snapshot.count).toBe(4);
    expect(snapshot.handleAt(0)).toBe(0);
    expect(o.handleAt(0)).not.toBe(0); // the live order has moved on
    expect(o.layout().count).toBe(5);
  });

  it('reuses one snapshot until the order changes', () => {
    const o = new RowOrder(4);
    expect(o.layout()).toBe(o.layout());
    const first = o.layout();
    o.insert(id(1), 'V');
    expect(o.layout()).not.toBe(first);
  });
});
