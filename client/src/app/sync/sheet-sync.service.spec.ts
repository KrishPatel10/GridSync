import { TestBed } from '@angular/core/testing';
import { FORMULA_BACKEND_FACTORY, FormulaBackend } from '../formulas/formula-backend';
import { handleRequest, WorkerRequest } from '../formulas/formula-worker-protocol';
import { FormulaUpdate, RawChange, SheetCalculator } from '../formulas/sheet-calculator';
import { InMemoryOutboxStorage, OUTBOX_STORAGE_FACTORY } from './outbox-storage';
import { SheetSyncService } from './sheet-sync.service';
import { CellOp } from './sync.models';

// These tests never talk to a server, and jsdom has no page origin to resolve "/hubs/sheet"
// against. So SignalR is replaced with an inert connection that answers just enough to join.
const hub = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock('@microsoft/signalr', () => {
  const connection = {
    state: 'Disconnected',
    on: (name: string, handler: (...args: unknown[]) => void) => hub.handlers.set(name, handler),
    onreconnecting: () => undefined,
    onreconnected: () => undefined,
    onclose: () => undefined,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    invoke: (method: string) =>
      Promise.resolve(method === 'JoinSheet' ? { rows: 100_000, cols: 26, cells: [], users: [] } : { rejected: [] }),
    send: () => Promise.resolve(),
  };
  const builder = {
    withUrl: () => builder,
    withAutomaticReconnect: () => builder,
    configureLogging: () => builder,
    build: () => connection,
  };
  return {
    HubConnectionBuilder: function () {
      return builder;
    },
    HubConnectionState: { Disconnected: 'Disconnected' },
    LogLevel: { Warning: 3 },
  };
});

/** Joins the (fake) sheet, so the service knows the sheet size and formulas can reference cells. */
async function join(sync: SheetSyncService): Promise<void> {
  sync.connect('demo');
  await vi.waitFor(() => expect(sync.dims().rows).toBe(100_000));
}

/** A remote replica's edit, as it arrives from the hub. */
function remoteOp(row: number, col: number, value: string | null, wallMs: number): CellOp {
  return { row, col, value, ts: { wallMs, counter: 0, nodeId: 'someone-else' } };
}

/**
 * Stands in for a worker: the calculator runs behind a structured-clone boundary (as
 * postMessage would copy the data) and answers only when told to, so the "before the worker has
 * replied" state can be observed.
 */
class FakeWorkerBackend implements FormulaBackend {
  onUpdates: (updates: readonly FormulaUpdate[]) => void = () => undefined;
  onFailure: () => void = () => undefined;
  disposed = false;

  private readonly calculator = new SheetCalculator();
  private queued: WorkerRequest[] = [];

  setDimensions(rows: number, cols: number): void {
    this.queued.push(structuredClone({ type: 'dimensions', rows, cols } as const));
  }

  applyChanges(changes: readonly RawChange[]): void {
    this.queued.push(structuredClone({ type: 'changes', changes } as const));
  }

  dispose(): void {
    this.disposed = true;
  }

  /** The worker gets to run: handle everything queued, in order, and reply. */
  answer(): void {
    const requests = this.queued;
    this.queued = [];
    for (const request of requests) {
      const updates = structuredClone(handleRequest(this.calculator, request));
      if (updates.length > 0) this.onUpdates(updates);
    }
  }
}

describe('SheetSyncService formulas', () => {
  beforeEach(() => hub.handlers.clear());

  describe('calculating on the calling thread (the default when there is no Worker)', () => {
    it('shows the computed value of a formula, and the raw text for everything else', () => {
      const sync = TestBed.inject(SheetSyncService);

      sync.setCell(0, 0, '=5+3');
      sync.setCell(0, 1, 'plain text');

      expect(sync.displayAt(0, 0)).toBe('8');
      expect(sync.valueAt(0, 0)).toBe('=5+3'); // the formula bar and the editor keep the raw text
      expect(sync.displayAt(0, 1)).toBe('plain text');
    });

    it('shows a formula as text again once it is cleared or replaced', () => {
      const sync = TestBed.inject(SheetSyncService);

      sync.setCell(2, 0, '=1+1');
      expect(sync.displayAt(2, 0)).toBe('2');

      sync.setCell(2, 0, '=2+2');
      expect(sync.displayAt(2, 0)).toBe('4');

      sync.setCell(2, 0, null);
      expect(sync.displayAt(2, 0)).toBe('');
    });

    it('shows #ERROR! for a formula that does not parse', () => {
      const sync = TestBed.inject(SheetSyncService);
      sync.setCell(3, 0, '=1+');
      expect(sync.displayAt(3, 0)).toBe('#ERROR!');
    });

    it('updates dependent formulas when another replica edits a cell they read', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      sync.setCell(0, 0, '=B1*2+SUM(C1:C3)');
      expect(sync.displayAt(0, 0)).toBe('0');

      // What the hub delivers when someone else edits B1, then C2 (inside the range).
      hub.handlers.get('opsApplied')?.([remoteOp(0, 1, '21', Date.now())]);
      expect(sync.displayAt(0, 0)).toBe('42');

      hub.handlers.get('opsApplied')?.([remoteOp(1, 2, '100', Date.now())]);
      expect(sync.displayAt(0, 0)).toBe('142');
    });

    it('applies a join snapshot containing formulas that read cells listed after them', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      // Snapshot order is arbitrary: the formula arrives before the cell it reads.
      hub.handlers.get('opsApplied')?.([remoteOp(0, 0, '=B1+1', Date.now()), remoteOp(0, 1, '9', Date.now())]);
      expect(sync.displayAt(0, 0)).toBe('10');
    });
  });

  describe('calculating in a worker', () => {
    let worker: FakeWorkerBackend;

    beforeEach(() => {
      worker = new FakeWorkerBackend();
      TestBed.configureTestingModule({ providers: [{ provide: FORMULA_BACKEND_FACTORY, useValue: () => worker }] });
    });

    it('shows a new formula as blank until the worker replies, then its value', () => {
      const sync = TestBed.inject(SheetSyncService);

      sync.setCell(0, 0, '=5+3');
      expect(sync.displayAt(0, 0)).toBe('');

      worker.answer();
      expect(sync.displayAt(0, 0)).toBe('8');
    });

    it('shows non-formula text at once, without waiting for the worker', () => {
      const sync = TestBed.inject(SheetSyncService);
      sync.setCell(0, 0, 'hello');
      expect(sync.displayAt(0, 0)).toBe('hello');
    });

    it('shows a formula that was replaced by plain text as that text at once, not its old result', () => {
      const sync = TestBed.inject(SheetSyncService);
      sync.setCell(0, 0, '=5+3');
      worker.answer();

      sync.setCell(0, 0, 'now text');
      expect(sync.displayAt(0, 0)).toBe('now text'); // no need to wait for the worker
    });

    it('keeps the old result visible while a changed formula is recalculated', () => {
      const sync = TestBed.inject(SheetSyncService);
      sync.setCell(0, 0, '=5+3');
      worker.answer();

      sync.setCell(0, 0, '=10+10');
      expect(sync.displayAt(0, 0)).toBe('8'); // stale for a moment, then:
      worker.answer();
      expect(sync.displayAt(0, 0)).toBe('20');
    });

    it('sends only plain, cloneable data to the worker', () => {
      const sync = TestBed.inject(SheetSyncService);
      // FakeWorkerBackend structuredClones every request; this would throw on a function or a class.
      expect(() => {
        sync.setCell(0, 0, '=1+1');
        sync.setCell(0, 1, 'x');
      }).not.toThrow();
    });

    it('carries on calculating in the page if the worker fails, without losing any cell', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      sync.setCell(0, 0, '=5+3');
      sync.setCell(0, 1, '=A1*2');
      worker.answer();
      expect(sync.displayAt(0, 1)).toBe('16');

      sync.setCell(0, 2, '=B1+1'); // asked, never answered: the worker is about to fail
      expect(sync.displayAt(0, 2)).toBe('');

      worker.onFailure();

      expect(worker.disposed).toBe(true);
      expect(['A1', 'B1', 'C1'].map((_, col) => sync.displayAt(0, col))).toEqual(['8', '16', '17']);

      // And it keeps working afterwards.
      sync.setCell(0, 0, '=100');
      expect(sync.displayAt(0, 2)).toBe('201');
    });
  });

  describe('offline durability (unsent edits survive closing the tab)', () => {
    let storage: InMemoryOutboxStorage;

    beforeEach(() => {
      storage = new InMemoryOutboxStorage();
      TestBed.configureTestingModule({ providers: [{ provide: OUTBOX_STORAGE_FACTORY, useValue: () => storage }] });
    });

    it('recovers edits an abandoned tab on the same sheet left unsent', async () => {
      await storage.put({
        sheetId: 'demo',
        nodeId: 'gone',
        ops: [{ row: 2, col: 1, value: 'left behind', ts: { wallMs: 1, counter: 0, nodeId: 'gone' } }],
        lastSeenMs: Date.now() - 20_000,
      });

      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      expect(sync.valueAt(2, 1)).toBe('left behind');
      // The fake hub accepts instantly, so by the time join() resolves this has already synced.
      await vi.waitFor(() => expect(sync.pendingCount()).toBe(0));
      expect(await storage.getForSheet('demo')).toEqual([]); // nothing left to recover a second time
    });

    it('leaves a record alone if it looks like its tab could still be open', async () => {
      await storage.put({
        sheetId: 'demo',
        nodeId: 'maybe-alive',
        ops: [{ row: 0, col: 0, value: 'do not touch', ts: { wallMs: 1, counter: 0, nodeId: 'maybe-alive' } }],
        lastSeenMs: Date.now() - 1_000, // well under the staleness threshold
      });

      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      expect(sync.valueAt(0, 0)).toBe('');
    });

    it('only recovers edits left for the sheet actually being opened', async () => {
      await storage.put({
        sheetId: 'a-different-sheet',
        nodeId: 'gone',
        ops: [{ row: 0, col: 0, value: 'elsewhere', ts: { wallMs: 1, counter: 0, nodeId: 'gone' } }],
        lastSeenMs: Date.now() - 20_000,
      });

      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      expect(sync.valueAt(0, 0)).toBe('');
    });

    it('persists a local edit, so a later reload of this sheet could recover it', async () => {
      const sync = TestBed.inject(SheetSyncService);
      sync.setCell(0, 0, 'not sent yet');

      await vi.waitFor(async () => {
        const records = await storage.getForSheet('demo');
        expect(records.some((r) => r.ops.some((op) => op.value === 'not sent yet'))).toBe(true);
      });
    });

    it('clears the persisted record once every edit has reached the server', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync); // 'live', so the edit below flushes on its own

      sync.setCell(0, 0, 'will be sent');
      await vi.waitFor(() => expect(sync.pendingCount()).toBe(0));
      await vi.waitFor(async () => expect(await storage.getForSheet('demo')).toEqual([]));
    });

    it('reports durability honestly: false for the in-memory fallback (what a browser without IndexedDB actually gets)', () => {
      const sync = TestBed.inject(SheetSyncService);
      expect(sync.durableOffline()).toBe(false);
    });

    it('keeps refreshing a live tabs own record so another tab never mistakes it for abandoned', async () => {
      vi.useFakeTimers();
      try {
        const sync = TestBed.inject(SheetSyncService);
        sync.setCell(0, 0, 'still typing');
        await vi.advanceTimersByTimeAsync(1); // let the microtask-scheduled write land

        const before = (await storage.getForSheet('demo'))[0].lastSeenMs;
        await vi.advanceTimersByTimeAsync(4_000); // the heartbeat interval

        const after = (await storage.getForSheet('demo'))[0].lastSeenMs;
        expect(after).toBeGreaterThan(before);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
