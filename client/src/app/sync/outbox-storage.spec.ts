import { InMemoryOutboxStorage, isDurable, IndexedDbOutboxStorage, OutboxRecord } from './outbox-storage';

const record = (sheetId: string, nodeId: string, lastSeenMs = 1): OutboxRecord => ({
  sheetId,
  nodeId,
  ops: [{ rowId: 'b0', col: 0, value: 'x', ts: { wallMs: 1, counter: 0, nodeId } }],
  lastSeenMs,
});

describe('InMemoryOutboxStorage', () => {
  it('returns nothing for a sheet with no records', async () => {
    const storage = new InMemoryOutboxStorage();
    expect(await storage.getForSheet('demo')).toEqual([]);
  });

  it('stores a record and returns it for its sheet', async () => {
    const storage = new InMemoryOutboxStorage();
    await storage.put(record('demo', 'node-a'));
    expect(await storage.getForSheet('demo')).toEqual([record('demo', 'node-a')]);
  });

  it('keeps different sheets separate', async () => {
    const storage = new InMemoryOutboxStorage();
    await storage.put(record('sheet-1', 'node-a'));
    await storage.put(record('sheet-2', 'node-a'));
    expect(await storage.getForSheet('sheet-1')).toEqual([record('sheet-1', 'node-a')]);
  });

  it('keeps different tabs on the same sheet from overwriting each other', async () => {
    const storage = new InMemoryOutboxStorage();
    await storage.put(record('demo', 'node-a'));
    await storage.put(record('demo', 'node-b'));

    const found = await storage.getForSheet('demo');
    expect(found).toHaveLength(2);
    expect(new Set(found.map((r) => r.nodeId))).toEqual(new Set(['node-a', 'node-b']));
  });

  it('put replaces a record with the same sheet and node id', async () => {
    const storage = new InMemoryOutboxStorage();
    await storage.put(record('demo', 'node-a', 1));
    await storage.put(record('demo', 'node-a', 2));
    expect(await storage.getForSheet('demo')).toEqual([record('demo', 'node-a', 2)]);
  });

  it('deletes only the named record', async () => {
    const storage = new InMemoryOutboxStorage();
    await storage.put(record('demo', 'node-a'));
    await storage.put(record('demo', 'node-b'));

    await storage.delete('demo', 'node-a');

    expect(await storage.getForSheet('demo')).toEqual([record('demo', 'node-b')]);
  });

  it('deleting a record that does not exist is not an error', async () => {
    const storage = new InMemoryOutboxStorage();
    await expect(storage.delete('demo', 'nobody')).resolves.toBeUndefined();
  });
});

describe('isDurable', () => {
  it('is false for the in-memory fallback', () => {
    expect(isDurable(new InMemoryOutboxStorage())).toBe(false);
  });

  it('is true for real IndexedDB storage', () => {
    expect(isDurable(new IndexedDbOutboxStorage())).toBe(true);
  });
});
