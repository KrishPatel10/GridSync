import { InMemoryOutboxStorage } from './outbox-storage';
import { PendingEditsOutbox } from './pending-edits-outbox';
import { CellOp } from './sync.models';

const op = (row: number, col: number, value: string | null, wallMs: number, nodeId = 'n'): CellOp => ({
  row,
  col,
  value,
  ts: { wallMs, counter: 0, nodeId },
});

/** A clock the test controls, matching how hlc.spec.ts and the C# ManualTimeProvider work. */
function manualClock(startMs: number) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('PendingEditsOutbox', () => {
  describe('persist', () => {
    it('stores this tabs pending ops under its own node id, stamped with the current time', async () => {
      const storage = new InMemoryOutboxStorage();
      const clock = manualClock(1_000);
      const outbox = new PendingEditsOutbox(storage, clock.now);

      await outbox.persist('demo', 'node-a', [op(0, 0, 'x', 1)]);

      expect(await storage.getForSheet('demo')).toEqual([
        { sheetId: 'demo', nodeId: 'node-a', ops: [op(0, 0, 'x', 1)], lastSeenMs: 1_000 },
      ]);
    });

    it('deletes the record once there is nothing left to persist', async () => {
      const storage = new InMemoryOutboxStorage();
      const outbox = new PendingEditsOutbox(storage);

      await outbox.persist('demo', 'node-a', [op(0, 0, 'x', 1)]);
      await outbox.persist('demo', 'node-a', []);

      expect(await storage.getForSheet('demo')).toEqual([]);
    });

    it('does not disturb another tabs record for the same sheet', async () => {
      const storage = new InMemoryOutboxStorage();
      const outbox = new PendingEditsOutbox(storage);

      await outbox.persist('demo', 'node-a', [op(0, 0, 'a', 1)]);
      await outbox.persist('demo', 'node-b', [op(1, 0, 'b', 1)]);

      expect(await storage.getForSheet('demo')).toHaveLength(2);
    });
  });

  describe('harvestStaleOps', () => {
    it('recovers ops from a record old enough to count as abandoned', async () => {
      const storage = new InMemoryOutboxStorage();
      const clock = manualClock(0);
      const outbox = new PendingEditsOutbox(storage, clock.now);

      await outbox.persist('demo', 'gone', [op(2, 3, 'left behind', 0)]);
      clock.advance(20_000);

      expect(await outbox.harvestStaleOps('demo', 12_000)).toEqual([op(2, 3, 'left behind', 0)]);
    });

    it('leaves a record alone if it was touched recently: its tab may still be alive', async () => {
      const storage = new InMemoryOutboxStorage();
      const clock = manualClock(0);
      const outbox = new PendingEditsOutbox(storage, clock.now);

      await outbox.persist('demo', 'maybe-alive', [op(0, 0, 'x', 0)]);
      clock.advance(5_000); // under the 12,000ms threshold

      expect(await outbox.harvestStaleOps('demo', 12_000)).toEqual([]);
      expect(await storage.getForSheet('demo')).toHaveLength(1); // not touched
    });

    it('is exactly at the boundary: staleAfterMs old counts as stale', async () => {
      const storage = new InMemoryOutboxStorage();
      const clock = manualClock(0);
      const outbox = new PendingEditsOutbox(storage, clock.now);

      await outbox.persist('demo', 'edge', [op(0, 0, 'x', 0)]);
      clock.advance(12_000);

      expect(await outbox.harvestStaleOps('demo', 12_000)).toHaveLength(1);
    });

    it('removes the harvested records so they are not recovered twice', async () => {
      const storage = new InMemoryOutboxStorage();
      const clock = manualClock(0);
      const outbox = new PendingEditsOutbox(storage, clock.now);

      await outbox.persist('demo', 'gone', [op(0, 0, 'x', 0)]);
      clock.advance(20_000);

      await outbox.harvestStaleOps('demo', 12_000);
      expect(await outbox.harvestStaleOps('demo', 12_000)).toEqual([]);
    });

    it('only harvests the requested sheet', async () => {
      const storage = new InMemoryOutboxStorage();
      const clock = manualClock(0);
      const outbox = new PendingEditsOutbox(storage, clock.now);

      await outbox.persist('sheet-1', 'gone', [op(0, 0, 'x', 0)]);
      await outbox.persist('sheet-2', 'also-gone', [op(0, 0, 'y', 0)]);
      clock.advance(20_000);

      expect(await outbox.harvestStaleOps('sheet-1', 12_000)).toEqual([op(0, 0, 'x', 0)]);
      expect(await storage.getForSheet('sheet-2')).toHaveLength(1); // untouched by harvesting sheet-1
    });

    it('merges several abandoned records, keeping the newest write per cell', async () => {
      const storage = new InMemoryOutboxStorage();
      const clock = manualClock(0);
      const outbox = new PendingEditsOutbox(storage, clock.now);

      // Two dead tabs both touched (0,0); tab "b" wrote it later (higher wallMs) and should win.
      await outbox.persist('demo', 'a', [op(0, 0, 'first', 10), op(0, 1, 'only a', 10)]);
      await outbox.persist('demo', 'b', [op(0, 0, 'second, newer', 20)]);
      clock.advance(20_000);

      const recovered = await outbox.harvestStaleOps('demo', 12_000);
      expect(recovered).toEqual(
        expect.arrayContaining([op(0, 0, 'second, newer', 20), op(0, 1, 'only a', 10)]),
      );
      expect(recovered).toHaveLength(2);
    });

    it('ignores a record with no ops left', async () => {
      const storage = new InMemoryOutboxStorage();
      const clock = manualClock(0);
      const outbox = new PendingEditsOutbox(storage, clock.now);

      await outbox.persist('demo', 'empty', []); // persist() deletes on empty, but guard the case anyway
      clock.advance(20_000);

      expect(await outbox.harvestStaleOps('demo', 12_000)).toEqual([]);
    });
  });
});
