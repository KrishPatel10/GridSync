import { TestBed } from '@angular/core/testing';
import { FORMULA_BACKEND_FACTORY, FormulaBackend } from '../formulas/formula-backend';
import { handleRequest, WorkerRequest } from '../formulas/formula-worker-protocol';
import { FormulaUpdate, RawChange, SheetCalculator } from '../formulas/sheet-calculator';
import { between, forBaseRow } from '../rows/fractional-index';
import { InMemoryOutboxStorage, OUTBOX_STORAGE_FACTORY } from './outbox-storage';
import { SheetSyncService } from './sheet-sync.service';
import { CellOp, PROTOCOL_VERSION, RowOp, UserPresence } from './sync.models';

// These tests never talk to a server, and jsdom has no page origin to resolve "/hubs/sheet"
// against. So SignalR is replaced with an inert connection that answers just enough to join.
const hub = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  invocations: [] as { method: string; args: unknown[] }[],
  /** While true, ApplyOps never answers, so edits stay unsent and can be inspected. */
  holdApply: false,
  /** When set, ApplyOps answers with this instead of accepting. */
  applyResult: null as unknown,
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
    invoke: (method: string, ...args: unknown[]) => {
      hub.invocations.push({ method, args });
      if (method === 'ApplyOps' && hub.holdApply) return new Promise(() => undefined);
      if (method === 'ApplyOps' && hub.applyResult) return Promise.resolve(hub.applyResult);
      return Promise.resolve(
        method === 'JoinSheet' ? { rows: 100_000, cols: 26, insertedRows: [], cells: [], users: [] } : { rejected: [] },
      );
    },
    send: (method: string, ...args: unknown[]) => {
      hub.invocations.push({ method, args });
      return Promise.resolve();
    },
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
  return { rowId: `b${row}`, col, value, ts: { wallMs, counter: 0, nodeId: 'someone-else' } };
}

/** What the hub sends when another replica's edits arrive: row inserts, then cell edits. */
function deliver(rows: RowOp[], cells: CellOp[]): void {
  hub.handlers.get('opsApplied')?.(rows, cells);
}

const applyCalls = () => hub.invocations.filter((i) => i.method === 'ApplyOps');

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

  reset(rows: number, cols: number, changes: readonly RawChange[]): void {
    this.queued.push(structuredClone({ type: 'reset', rows, cols, changes } as const));
  }

  dispose(): void {
    this.disposed = true;
  }

  /** The worker gets to run one request, then stops: for looking at the moment between two replies. */
  answerOne(): void {
    const request = this.queued.shift();
    if (request) this.onUpdates(structuredClone(handleRequest(this.calculator, request)));
  }

  /** The worker gets to run: handle everything queued, in order, and reply to each. */
  answer(): void {
    const requests = this.queued;
    this.queued = [];
    for (const request of requests) {
      // Like the real worker: one reply per request, in order, even an empty one.
      this.onUpdates(structuredClone(handleRequest(this.calculator, request)));
    }
  }
}

describe('SheetSyncService formulas', () => {
  beforeEach(() => {
    hub.handlers.clear();
    hub.invocations.length = 0;
    hub.holdApply = false;
    hub.applyResult = null;
  });

  describe('calculating on the calling thread (the default when there is no Worker)', () => {
    it('shows the computed value of a formula, and the raw text for everything else', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      sync.setCell(0, 0, '=5+3');
      sync.setCell(0, 1, 'plain text');

      expect(sync.displayAt(0, 0)).toBe('8');
      expect(sync.valueAt(0, 0)).toBe('=5+3'); // the formula bar and the editor keep the text as typed
      expect(sync.displayAt(0, 1)).toBe('plain text');
    });

    it('shows a formula as text again once it is cleared or replaced', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      sync.setCell(2, 0, '=1+1');
      expect(sync.displayAt(2, 0)).toBe('2');

      sync.setCell(2, 0, '=2+2');
      expect(sync.displayAt(2, 0)).toBe('4');

      sync.setCell(2, 0, null);
      expect(sync.displayAt(2, 0)).toBe('');
    });

    it('shows #ERROR! for a formula that does not parse', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      sync.setCell(3, 0, '=1+');
      expect(sync.displayAt(3, 0)).toBe('#ERROR!');
    });

    it('updates dependent formulas when another replica edits a cell they read', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      sync.setCell(0, 0, '=B1*2+SUM(C1:C3)');
      expect(sync.displayAt(0, 0)).toBe('0');

      // What the hub delivers when someone else edits B1, then C2 (inside the range).
      deliver([], [remoteOp(0, 1, '21', Date.now())]);
      expect(sync.displayAt(0, 0)).toBe('42');

      deliver([], [remoteOp(1, 2, '100', Date.now())]);
      expect(sync.displayAt(0, 0)).toBe('142');
    });

    it('applies a join snapshot containing formulas that read cells listed after them', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      // Snapshot order is arbitrary: the formula arrives before the cell it reads.
      deliver([], [remoteOp(0, 0, '=B1+1', Date.now()), remoteOp(0, 1, '9', Date.now())]);
      expect(sync.displayAt(0, 0)).toBe('10');
    });

    it('stores a formula naming rows by id, so it can follow them, while showing it as typed', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      hub.holdApply = true;

      sync.setCell(0, 0, '=B5+1');
      await vi.waitFor(() => expect(applyCalls()).toHaveLength(1));

      const [, cells] = applyCalls()[0].args as [RowOp[], CellOp[]];
      expect(cells[0].value).toBe('=B_b4+1'); // what crosses the network
      expect(sync.valueAt(0, 0)).toBe('=B5+1'); // what the person sees
    });
  });

  describe('calculating in a worker', () => {
    let worker: FakeWorkerBackend;

    beforeEach(() => {
      worker = new FakeWorkerBackend();
      TestBed.configureTestingModule({ providers: [{ provide: FORMULA_BACKEND_FACTORY, useValue: () => worker }] });
    });

    it('shows a new formula as blank until the worker replies, then its value', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      worker.answer();

      sync.setCell(0, 0, '=5+3');
      expect(sync.displayAt(0, 0)).toBe('');

      worker.answer();
      expect(sync.displayAt(0, 0)).toBe('8');
    });

    it('shows non-formula text at once, without waiting for the worker', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      sync.setCell(0, 0, 'hello');
      expect(sync.displayAt(0, 0)).toBe('hello');
    });

    it('shows a formula that was replaced by plain text as that text at once, not its old result', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      sync.setCell(0, 0, '=5+3');
      worker.answer();

      sync.setCell(0, 0, 'now text');
      expect(sync.displayAt(0, 0)).toBe('now text'); // no need to wait for the worker
    });

    it('keeps the old result visible while a changed formula is recalculated', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      sync.setCell(0, 0, '=5+3');
      worker.answer();

      sync.setCell(0, 0, '=10+10');
      expect(sync.displayAt(0, 0)).toBe('8'); // stale for a moment, then:
      worker.answer();
      expect(sync.displayAt(0, 0)).toBe('20');
    });

    it('sends only plain, cloneable data to the worker', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      // FakeWorkerBackend structuredClones every request; this would throw on a function or a class.
      expect(() => {
        sync.setCell(0, 0, '=1+1');
        sync.setCell(0, 1, 'x');
        sync.insertRows(0, 1);
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

    it('puts a late reply on the right cell even though rows moved while it was being worked out', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      worker.answer();

      sync.setCell(0, 0, '=5+3'); // asked while the formula is in row 1...
      sync.insertRows(0, 1); // ...then a row goes in above it, before the worker has answered

      // The first reply is about the formula as it was in row 1. It must land on that formula, which
      // is now in row 2, and not on whatever is in row 1 now.
      worker.answerOne();
      expect(sync.displayAt(1, 0)).toBe('8');
      expect(sync.displayAt(0, 0)).toBe('');

      worker.answer(); // the reply to the row insert changes nothing
      expect(sync.displayAt(0, 0)).toBe(''); // the new, empty row
      expect(sync.displayAt(1, 0)).toBe('8'); // the formula, one row down, with its result
    });
  });

  describe('inserting rows', () => {
    it('adds rows without renumbering: every cell keeps its row, and moves down with it', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      sync.setCell(1, 0, 'second');
      sync.setCell(2, 0, 'third');

      const at = sync.insertRows(2, 1);

      expect(at).toBe(2);
      expect(sync.dims().rows).toBe(100_001);
      expect(sync.displayAt(1, 0)).toBe('second'); // above the insert: unmoved
      expect(sync.displayAt(2, 0)).toBe(''); // the new row
      expect(sync.displayAt(3, 0)).toBe('third'); // below: one down
    });

    it('can add several rows at once, and at the very start and end', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      sync.setCell(0, 0, 'first');

      sync.insertRows(0, 3);
      expect(sync.displayAt(3, 0)).toBe('first');

      sync.insertRows(sync.dims().rows, 2);
      expect(sync.dims().rows).toBe(100_005);
      expect(sync.displayAt(100_004, 0)).toBe('');
    });

    it('sends new rows ahead of the cell edits that need them, in one batch', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      sync.insertRows(0, 2);
      sync.setCell(0, 0, 'in a new row');
      await vi.waitFor(() => expect(sync.pendingCount()).toBe(0));

      const calls = applyCalls();
      expect(calls).toHaveLength(1);
      const [rows, cells] = calls[0].args as [RowOp[], CellOp[]];
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.rowId).toMatch(/^[0-9a-f]{32}$/);
      expect(cells).toHaveLength(1);
      expect(cells[0].rowId).toBe(rows[0].rowId); // row 0 is the first of the two new ones
    });

    it('does not send a row again once the server has it', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      sync.insertRows(0, 1);
      await vi.waitFor(() => expect(sync.pendingCount()).toBe(0));
      sync.setCell(0, 0, 'later');
      await vi.waitFor(() => expect(applyCalls()).toHaveLength(2));

      const [rows] = applyCalls()[1].args as [RowOp[], CellOp[]];
      expect(rows).toEqual([]);
    });

    it('makes formulas follow their rows', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      sync.setCell(5, 0, '10');
      sync.setCell(0, 1, '=A6*2');
      expect(sync.displayAt(0, 1)).toBe('20');

      sync.insertRows(0, 3);

      expect(sync.displayAt(8, 0)).toBe('10'); // the value moved from row 6 to row 9
      expect(sync.displayAt(3, 1)).toBe('20'); // the formula moved from row 1 to row 4, still reading it
      expect(sync.valueAt(3, 1)).toBe('=A9*2'); // and its text now says so
    });

    it('grows a range that a row is inserted into', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      sync.setCell(0, 0, '1');
      sync.setCell(1, 0, '2');
      sync.setCell(2, 0, '3');
      sync.setCell(0, 1, '=SUM(A1:A3)');
      expect(sync.displayAt(0, 1)).toBe('6');

      sync.insertRows(1, 1); // between A1 and A2
      expect(sync.valueAt(0, 1)).toBe('=SUM(A1:A4)');
      sync.setCell(1, 0, '10');

      expect(sync.displayAt(0, 1)).toBe('16');
    });

    it('leaves a formula alone when rows go in below everything it reads', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      sync.setCell(0, 0, '4');
      sync.setCell(0, 1, '=A1+1');

      sync.insertRows(50, 5);

      expect(sync.valueAt(0, 1)).toBe('=A1+1');
      expect(sync.displayAt(0, 1)).toBe('5');
    });

    it('applies a row insert from another replica the same way', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      sync.setCell(1, 0, 'mine');
      const theirRow = 'a'.repeat(32);

      deliver(
        [{ rowId: theirRow, key: between(forBaseRow(0), forBaseRow(1)) }],
        [{ rowId: theirRow, col: 0, value: 'theirs', ts: { wallMs: Date.now(), counter: 0, nodeId: 'someone-else' } }],
      );

      expect(sync.dims().rows).toBe(100_001);
      expect(sync.displayAt(1, 0)).toBe('theirs');
      expect(sync.displayAt(2, 0)).toBe('mine');
    });

    it('ignores a row it already has', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      const row = { rowId: 'b'.repeat(32), key: between(forBaseRow(0), forBaseRow(1)) };

      deliver([row], []);
      deliver([row], []);

      expect(sync.dims().rows).toBe(100_001);
    });

    it('keeps a formula reading the same row when another replica inserts above it', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      sync.setCell(2, 0, '7');
      sync.setCell(0, 1, '=A3');
      expect(sync.displayAt(0, 1)).toBe('7');

      deliver([{ rowId: 'c'.repeat(32), key: between(null, forBaseRow(0)) }], []);

      expect(sync.displayAt(1, 1)).toBe('7');
      expect(sync.valueAt(1, 1)).toBe('=A4');
    });

    it('shares your selection by row id, so others see the right row', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      sync.insertRows(0, 1); // the row at position 1 is now the sheet's first initial row, "b0"

      sync.shareSelection(1, 2);

      await vi.waitFor(() => {
        const sent = hub.invocations.filter((i) => i.method === 'SelectCell');
        expect(sent.at(-1)?.args).toEqual(['b0', 2]);
      });
    });

    it("moves another person's cursor with their row when rows are inserted above it", async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      const peer: UserPresence = { connectionId: 'c1', nodeId: 'n1', name: 'Bo', color: '#112233', rowId: 'b3', col: 1 };
      hub.handlers.get('presenceChanged')?.(peer);
      expect(sync.peersAt(3, 1)).toHaveLength(1);

      sync.insertRows(0, 2);

      expect(sync.peersAt(3, 1)).toHaveLength(0);
      expect(sync.peersAt(5, 1)).toHaveLength(1);
    });

    it('speaks the current protocol version when joining', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      const joinCall = hub.invocations.find((i) => i.method === 'JoinSheet');
      expect(joinCall?.args.at(-1)).toBe(PROTOCOL_VERSION);
    });

    it('names a refused edit by its current row number, counting rows before cells as the server does', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      // One row and one cell go up together; the server refuses index 1, which is the cell.
      hub.applyResult = { accepted: 1, stale: 0, rejected: [{ index: 1, reason: 'ValueTooLong' }] };

      sync.insertRows(0, 1);
      sync.setCell(0, 0, 'x');

      await vi.waitFor(() => expect(sync.problem()).toContain('row 1'));
      expect(sync.problem()).toContain('ValueTooLong');
    });

    it('says so when a row insert is refused', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      hub.applyResult = { accepted: 0, stale: 0, rejected: [{ index: 0, reason: 'TooManyRows' }] };

      sync.insertRows(0, 1);

      await vi.waitFor(() => expect(sync.problem()).toContain('a new row'));
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
        ops: [{ rowId: 'b2', col: 1, value: 'left behind', ts: { wallMs: 1, counter: 0, nodeId: 'gone' } }],
        lastSeenMs: Date.now() - 20_000,
      });

      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      expect(sync.valueAt(2, 1)).toBe('left behind');
      // The fake hub accepts instantly, so by the time join() resolves this has already synced.
      await vi.waitFor(() => expect(sync.pendingCount()).toBe(0));
      expect(await storage.getForSheet('demo')).toEqual([]); // nothing left to recover a second time
    });

    it('recovers a row an abandoned tab inserted, and what was typed into it', async () => {
      const rowId = 'd'.repeat(32);
      await storage.put({
        sheetId: 'demo',
        nodeId: 'gone',
        ops: [{ rowId, col: 0, value: 'typed in a new row', ts: { wallMs: 1, counter: 0, nodeId: 'gone' } }],
        rows: [{ rowId, key: between(forBaseRow(0), forBaseRow(1)) }],
        lastSeenMs: Date.now() - 20_000,
      });

      const sync = TestBed.inject(SheetSyncService);
      sync.connect('demo'); // not join(): the sheet opens with the recovered row already in it

      await vi.waitFor(() => expect(sync.dims().rows).toBe(100_001));
      expect(sync.valueAt(1, 0)).toBe('typed in a new row');
      await vi.waitFor(() => expect(sync.pendingCount()).toBe(0));

      const [rows, cells] = applyCalls()[0].args as [RowOp[], CellOp[]];
      expect(rows.map((r) => r.rowId)).toEqual([rowId]); // the same row, not a new one
      expect(cells.map((c) => c.rowId)).toEqual([rowId]);
    });

    it('leaves a record alone if it looks like its tab could still be open', async () => {
      await storage.put({
        sheetId: 'demo',
        nodeId: 'maybe-alive',
        ops: [{ rowId: 'b0', col: 0, value: 'do not touch', ts: { wallMs: 1, counter: 0, nodeId: 'maybe-alive' } }],
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
        ops: [{ rowId: 'b0', col: 0, value: 'elsewhere', ts: { wallMs: 1, counter: 0, nodeId: 'gone' } }],
        lastSeenMs: Date.now() - 20_000,
      });

      const sync = TestBed.inject(SheetSyncService);
      await join(sync);

      expect(sync.valueAt(0, 0)).toBe('');
    });

    it('persists a local edit, so a later reload of this sheet could recover it', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      hub.holdApply = true; // the server never answers, so the edit stays unsent

      sync.setCell(0, 0, 'not sent yet');

      await vi.waitFor(async () => {
        const records = await storage.getForSheet('demo');
        expect(records.some((r) => r.ops.some((op) => op.value === 'not sent yet'))).toBe(true);
      });
    });

    it('persists an unsent row insert too', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync);
      hub.holdApply = true;

      sync.insertRows(0, 2);

      await vi.waitFor(async () => {
        const records = await storage.getForSheet('demo');
        expect(records.flatMap((r) => r.rows ?? [])).toHaveLength(2);
      });
    });

    it('clears the persisted record once every edit has reached the server', async () => {
      const sync = TestBed.inject(SheetSyncService);
      await join(sync); // 'live', so the edit below flushes on its own

      sync.insertRows(0, 1);
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
        hub.holdApply = true;
        sync.connect('demo');
        await vi.advanceTimersByTimeAsync(10); // joins the fake sheet
        expect(sync.dims().rows).toBe(100_000);

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
