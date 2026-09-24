import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  IRetryPolicy,
  LogLevel,
} from '@microsoft/signalr';
import { FORMULA_BACKEND_FACTORY, FormulaBackend, InlineFormulaBackend } from '../formulas/formula-backend';
import { toDisplayFormula, toStoredFormula } from '../formulas/formula-rows';
import { FormulaUpdate, RawChange } from '../formulas/sheet-calculator';
import { newRowId, RowLayout, RowOrder } from '../rows/row-order';
import { HybridLogicalClock } from './hlc';
import { createIdentity } from './identity';
import { cellCol, cellKey, cellRow, LwwCellMap } from './lww-map';
import { isDurable, OUTBOX_STORAGE_FACTORY } from './outbox-storage';
import { PendingEditsOutbox } from './pending-edits-outbox';
import {
  ApplyResult,
  CellOp,
  ConnectionState,
  JoinResult,
  PROTOCOL_VERSION,
  RowOp,
  SYNC_LIMITS,
  UserPresence,
} from './sync.models';

/** The most rows one insert may add at once (selecting 100 rows and inserting adds 100). */
export const MAX_ROWS_PER_INSERT = 100;

/** Identifies a cell by what it is, not where it is: stable when rows move. */
const wireKey = (rowId: string, col: number): string => `${rowId}:${col}`;

/** Keep retrying forever, backing off to one attempt every 10 seconds. */
const retryForever: IRetryPolicy = {
  nextRetryDelayInMilliseconds: ({ previousRetryCount }) => Math.min(500 * 2 ** previousRetryCount, 10_000),
};

const FLASH_MS = 1_400;
const PRESENCE_THROTTLE_MS = 60;
const NO_PEERS: readonly UserPresence[] = [];

/**
 * How long a tab's outbox record can go untouched before another tab treats it as abandoned and
 * recovers its edits. Must comfortably outlast a few missed heartbeats (a backgrounded tab's
 * timers can be throttled), so this is generous relative to OUTBOX_HEARTBEAT_MS.
 */
const OUTBOX_STALE_MS = 12_000;
/** How often a tab with unsent edits refreshes its outbox record, so an idle-but-open tab is never mistaken for closed. */
const OUTBOX_HEARTBEAT_MS = 4_000;

/**
 * Owns this tab's replica of the sheet and keeps it in sync with the server.
 *
 * Edits are applied locally first (so typing never waits on the network), then queued and sent
 * in batches. Because every replica merges with the same last-writer-wins rule, it doesn't matter
 * whether an edit reaches the server immediately, after a reconnect, or twice.
 */
@Injectable({ providedIn: 'root' })
export class SheetSyncService {
  readonly identity = createIdentity();

  private readonly hlc = new HybridLogicalClock(this.identity.nodeId);
  /**
   * Cells, keyed by (row handle, column). A handle is a small number this replica gives each row
   * (see RowOrder), so a cell's key never changes when rows are inserted above it.
   */
  private readonly cells = new LwwCellMap();
  /** Which rows exist and in what order. Empty until the first join tells us how many rows the sheet starts with. */
  private order = new RowOrder(0);
  /**
   * Turns the raw text in `cells` into computed values (formulas), off the UI thread when the
   * browser allows. Only raw text is synced; every replica derives the same values locally. It is
   * fed from every place `cells` changes, and answers through `formulaDisplays`.
   *
   * It thinks in row numbers, and numbers change when rows are inserted, so whenever the row order
   * changes it is handed the whole sheet again (see resetFormulas). Its answers can arrive after
   * rows have moved, so each request remembers the row order it was made against (`layoutsInFlight`)
   * and its reply is read back through that one.
   */
  private formulas: FormulaBackend;
  private readonly layoutsInFlight: RowLayout[] = [];
  /** The computed text to show for each formula cell, keyed like `cells` (row handle, column). */
  private readonly formulaDisplays = new Map<number, string>();
  private readonly createFormulaBackend = inject(FORMULA_BACKEND_FACTORY);
  /** Unsent local edits, one per cell. A newer edit to the same cell replaces the older one. */
  private readonly pending = new Map<string, CellOp>();
  /** Unsent row inserts. Always sent ahead of the cell edits, since an edit needs its row to exist. */
  private readonly pendingRows = new Map<string, RowOp>();
  private readonly connection: HubConnection;

  /**
   * Durable backup of `pending`, so closing the tab while offline loses nothing: see
   * pending-edits-outbox.ts. `_durableOffline` reports whether that backup is real (IndexedDB) or
   * just an in-memory stand-in, so the UI can warn honestly about what would actually be lost.
   */
  private readonly outboxStorage = inject(OUTBOX_STORAGE_FACTORY)();
  private readonly outbox = new PendingEditsOutbox(this.outboxStorage);
  private readonly _durableOffline = signal(isDurable(this.outboxStorage));
  private outboxPersistScheduled = false;
  private outboxHeartbeat: ReturnType<typeof setInterval> | undefined;

  private sheetId = 'demo';
  private hasJoinedOnce = false;
  private userWantsOffline = false;
  private flushing = false;
  private flushScheduled = false;
  private startAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSelection: { rowId: string; col: number } | undefined;
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  private flashBatch = 0;

  private readonly _version = signal(0);
  private readonly _state = signal<ConnectionState>('connecting');
  private readonly _cols = signal(0);
  /** Bumps when rows are inserted, so anything that depends on row order knows to recompute. */
  private readonly _layoutVersion = signal(0);
  private readonly _peers = signal<ReadonlyMap<string, UserPresence>>(new Map());
  private readonly _pendingCount = signal(0);
  private readonly _problem = signal<string | null>(null);
  private readonly _userOffline = signal(false);
  private readonly _flashes = signal<ReadonlyMap<number, { color: string | null; batch: number }>>(new Map());

  /** Bumps on every change to cell contents; templates read it to know when to re-render. */
  readonly version = this._version.asReadonly();
  readonly state = this._state.asReadonly();
  /** How many rows and columns there are now, inserted rows included. */
  readonly dims = computed(() => {
    this._layoutVersion();
    return { rows: this.order.count, cols: this._cols() };
  });
  readonly pendingCount = this._pendingCount.asReadonly();
  /** Latest thing that went wrong, phrased for the person using the sheet. */
  readonly problem = this._problem.asReadonly();
  /** True when the person chose "Go offline", as opposed to the network dropping. */
  readonly userOffline = this._userOffline.asReadonly();
  /** True when unsent edits actually survive closing the tab (a real IndexedDB, not the in-memory fallback). */
  readonly durableOffline = this._durableOffline.asReadonly();
  readonly peers = computed(() => [...this._peers().values()]);
  readonly filledCount = computed(() => {
    this._version();
    return this.cells.filledCount;
  });

  /** Other people's selections, indexed by cell for O(1) lookup while rendering. */
  private readonly peersByCell = computed(() => {
    this._layoutVersion(); // a peer's row is an id, which lands at a different position once rows move
    const byCell = new Map<number, UserPresence[]>();
    for (const peer of this._peers().values()) {
      if (peer.rowId === null || peer.col === null) continue;
      const handle = this.order.handleOf(peer.rowId);
      if (handle < 0) continue; // a row we have not heard of yet
      const key = cellKey(handle, peer.col);
      const list = byCell.get(key);
      if (list) list.push(peer);
      else byCell.set(key, [peer]);
    }
    return byCell;
  });

  constructor() {
    this.formulas = this.attachFormulas(this.createFormulaBackend());

    this.connection = new HubConnectionBuilder()
      .withUrl('/hubs/sheet')
      .withAutomaticReconnect(retryForever)
      .configureLogging(LogLevel.Warning)
      .build();

    // Handlers use block bodies on purpose: if a handler returns a value, the SignalR client
    // treats it as a reply to the server and logs an error.
    this.connection.on('opsApplied', (rows: RowOp[], ops: CellOp[]) => {
      this.mergeRemote(rows, ops, { flash: true });
    });
    this.connection.on('presenceChanged', (peer: UserPresence) => {
      this._peers.update((peers) => new Map(peers).set(peer.connectionId, peer));
    });
    this.connection.on('presenceLeft', (connectionId: string) => {
      this._peers.update((peers) => {
        const next = new Map(peers);
        next.delete(connectionId);
        return next;
      });
    });

    this.connection.onreconnecting(() => {
      this._state.set('reconnecting');
      this._peers.set(new Map()); // stale until we rejoin
    });
    // A reconnect gets a new connection id on the server, so we have to join the sheet again.
    this.connection.onreconnected(() => void this.joinAndFlush());
    this.connection.onclose(() => {
      this._state.set('offline');
      this._peers.set(new Map());
      if (!this.userWantsOffline) this.scheduleStart();
    });

    // Keeps the outbox record fresh while it holds anything, so another tab loading in the
    // meantime never mistakes this still-open tab for an abandoned one (see OUTBOX_STALE_MS).
    this.outboxHeartbeat = setInterval(() => this.persistOutboxNow(), OUTBOX_HEARTBEAT_MS);

    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.retryTimer);
      clearTimeout(this.selectionTimer);
      clearInterval(this.outboxHeartbeat);
      this.formulas.dispose();
      void this.connection.stop();
    });
  }

  // ----- formulas --------------------------------------------------------------------------

  private attachFormulas(backend: FormulaBackend): FormulaBackend {
    backend.onUpdates = (updates) => {
      this.applyFormulaUpdates(updates);
    };
    backend.onFailure = () => {
      this.recoverFormulas();
    };
    return backend;
  }

  /**
   * A reply to one request. The calculator names cells by row number as of that request, so the
   * numbers are turned back into row handles through the order the request was made against, not the
   * current one, which may have moved on.
   */
  private applyFormulaUpdates(updates: readonly FormulaUpdate[]): void {
    const layout = this.layoutsInFlight.shift();
    if (!layout) return;

    for (const [key, display] of updates) {
      const handle = layout.handleAt(cellRow(key));
      if (handle < 0) continue;
      const stored = cellKey(handle, cellCol(key));
      if (display === null) this.formulaDisplays.delete(stored);
      else this.formulaDisplays.set(stored, display);
    }
    if (updates.length > 0) this._version.update((v) => v + 1);
  }

  /** Hands the calculator a batch of changes, noting which row order they are in terms of. */
  private feedFormulas(changes: RawChange[]): void {
    this.layoutsInFlight.push(this.order.layout());
    this.formulas.applyChanges(changes);
  }

  /**
   * Starts the calculator over with every cell at its current position. Needed whenever rows are
   * inserted, since that changes the position of everything below and how every formula's
   * references read. The cost is one pass over the filled cells.
   */
  private resetFormulas(): void {
    this.layoutsInFlight.push(this.order.layout());
    this.formulas.reset(this.order.count, this._cols(), this.allRawChanges());
  }

  /** Every filled cell as the calculator wants it: at its row number, formulas with numbered references. */
  private allRawChanges(): RawChange[] {
    const changes: RawChange[] = [];
    this.cells.forEachFilled((handle, col, value) => {
      const row = this.order.indexOfHandle(handle);
      if (row >= 0) changes.push({ row, col, raw: this.asTyped(value) });
    });
    return changes;
  }

  /** The text of a cell as a person types and reads it: formulas name rows by number, not by id. */
  private asTyped(raw: string): string {
    return raw.charAt(0) === '=' ? toDisplayFormula(raw, this.order) : raw;
  }

  /**
   * The worker died or never started. Formulas are pure functions of the raw text we already
   * hold, so nothing is lost: calculate on this thread instead, from a full replay of the cells.
   */
  private recoverFormulas(): void {
    this.formulas.dispose();
    this.formulaDisplays.clear();
    this.layoutsInFlight.length = 0; // replies that were still coming died with the worker

    this.formulas = this.attachFormulas(new InlineFormulaBackend());
    this.resetFormulas();
    this._version.update((v) => v + 1);
  }

  // ----- lifecycle -------------------------------------------------------------------------

  connect(sheetId: string): void {
    this.sheetId = sheetId;
    void this.recoverThenStart();
  }

  /**
   * Before ever trying to reach the server, replays any edits an earlier, now-abandoned tab left
   * unsent for this sheet (see pending-edits-outbox.ts). They land in `pending` exactly like a
   * fresh local edit, so they show up at once and sync normally once the connection comes up.
   */
  private async recoverThenStart(): Promise<void> {
    const recovered = await this.outbox.harvestStaleOps(this.sheetId, OUTBOX_STALE_MS);
    // The sheet is not open yet, so the rows are not known and nothing can be applied to the grid.
    // They go straight into the outbox queues (and from there back to storage, since harvesting
    // deleted the old record), and reach the grid when the sheet opens, in mergeRemote.
    for (const row of recovered.rows) this.pendingRows.set(row.rowId, row);
    for (const op of recovered.cells) this.pending.set(wireKey(op.rowId, op.col), { ...op, ts: this.hlc.tick() });
    if (recovered.rows.length > 0 || recovered.cells.length > 0) {
      this._pendingCount.set(this.pending.size + this.pendingRows.size);
      this.scheduleOutboxPersist();
    }
    await this.start();
  }

  /** Disconnects on purpose, so you can edit offline and watch the merge when you come back. */
  async goOffline(): Promise<void> {
    this.userWantsOffline = true;
    this._userOffline.set(true);
    clearTimeout(this.retryTimer);
    await this.connection.stop();
  }

  async goOnline(): Promise<void> {
    this.userWantsOffline = false;
    this._userOffline.set(false);
    this.startAttempts = 0;
    await this.start();
  }

  private async start(): Promise<void> {
    if (this.connection.state !== HubConnectionState.Disconnected) return;
    this._state.set(this.hasJoinedOnce ? 'reconnecting' : 'connecting');
    try {
      await this.connection.start();
      this.startAttempts = 0;
      await this.joinAndFlush();
    } catch {
      this._state.set('offline');
      if (!this.userWantsOffline) this.scheduleStart();
    }
  }

  private scheduleStart(): void {
    clearTimeout(this.retryTimer);
    const delay = Math.min(1_000 * 2 ** this.startAttempts++, 10_000);
    this.retryTimer = setTimeout(() => void this.start(), delay);
  }

  private async joinAndFlush(): Promise<void> {
    try {
      const joined = await this.connection.invoke<JoinResult>(
        'JoinSheet',
        this.sheetId,
        this.identity.nodeId,
        this.identity.name,
        this.identity.color,
        PROTOCOL_VERSION,
      );

      // The first join tells us how many rows the sheet starts with. (It never changes after that.)
      const firstJoin = this.order.baseRows !== joined.rows;
      if (firstJoin) {
        this.order = new RowOrder(joined.rows);
        this._layoutVersion.update((v) => v + 1);
      }
      this._cols.set(joined.cols);
      this._peers.set(new Map(joined.users.map((u) => [u.connectionId, u])));
      // After a reconnect, flash whatever other people changed while we were away.
      this.mergeRemote(joined.insertedRows, joined.cells, { flash: this.hasJoinedOnce, reset: firstJoin });
      // Our own unsent edits are not on the server yet, and some (recovered from an earlier tab) are not in the grid yet either.
      this.mergeRemote([...this.pendingRows.values()], [...this.pending.values()], { flash: false });
      this.hasJoinedOnce = true;
      this._state.set('live');
      this._problem.set(null);

      if (this.lastSelection) this.shareSelectionOf(this.lastSelection.rowId, this.lastSelection.col);
      await this.flush();
    } catch (err) {
      this._problem.set(`Couldn't open sheet "${this.sheetId}": ${messageOf(err)}`);
      void this.connection.stop();
    }
  }

  // ----- reading ---------------------------------------------------------------------------

  // Rows are addressed by position here (what the grid works in) and translated to handles at the door.

  /** The handle of the row at a position: a number that names that row for good, however rows move. -1 if there is none. */
  handleAt(row: number): number {
    this._layoutVersion();
    return this.order.handleAt(row);
  }

  /** Where a row is now, given its handle. -1 if it is not a row here. */
  indexOfHandle(handle: number): number {
    this._layoutVersion();
    return this.order.indexOfHandle(handle);
  }

  /** The text of a cell as it is typed: what the formula bar and the editor show. Formulas name rows by number. */
  valueAt(row: number, col: number): string {
    this._version(); // register the dependency for whoever is rendering
    return this.asTyped(this.cells.get(this.order.handleAt(row), col)?.value ?? '');
  }

  /** What the grid shows in a cell: a formula's computed result, or the raw text for anything else. */
  displayAt(row: number, col: number): string {
    this._version();
    const handle = this.order.handleAt(row);
    const raw = this.cells.get(handle, col)?.value ?? '';
    // A formula shows blank for the moment it takes the worker to answer. Anything else shows as
    // typed, at once, whatever a previous formula in that cell had computed.
    return raw.charAt(0) === '=' ? (this.formulaDisplays.get(cellKey(handle, col)) ?? '') : raw;
  }

  /**
   * The displayed text of the non-empty cells in a block. Walks whichever is smaller, the block or
   * the set of stored cells, so selecting the whole sheet doesn't visit 2.6 million empty cells.
   */
  displaysIn(block: { top: number; left: number; bottom: number; right: number }): string[] {
    this._version();
    const out: string[] = [];
    const area = (block.bottom - block.top + 1) * (block.right - block.left + 1);

    if (area <= this.cells.filledCount) {
      for (let row = block.top; row <= block.bottom; row++) {
        for (let col = block.left; col <= block.right; col++) out.push(this.displayAt(row, col));
      }
    } else {
      this.cells.forEachFilled((handle, col) => {
        const row = this.order.indexOfHandle(handle);
        if (row >= block.top && row <= block.bottom && col >= block.left && col <= block.right) {
          out.push(this.displayAt(row, col));
        }
      });
    }
    return out;
  }

  peersAt(row: number, col: number): readonly UserPresence[] {
    return this.peersByCell().get(cellKey(this.order.handleAt(row), col)) ?? NO_PEERS;
  }

  /** The ink color of whoever just changed this cell, or undefined if nothing just changed. */
  flashAt(row: number, col: number): string | null | undefined {
    return this._flashes().get(cellKey(this.order.handleAt(row), col))?.color;
  }

  // ----- writing ---------------------------------------------------------------------------

  /**
   * Sets a cell, given where it is now and what was typed. An empty string clears it. Applied
   * locally at once, synced in the background.
   *
   * A formula is stored with its references naming rows by id, not number (see formula-rows.ts), so
   * that it keeps pointing at the same rows when someone inserts a row above them.
   */
  setCell(row: number, col: number, value: string | null): void {
    const handle = this.order.handleAt(row);
    const rowId = this.order.idOfHandle(handle);
    if (rowId === undefined) return;

    let next = value === null || value === '' ? null : value.slice(0, SYNC_LIMITS.maxValueLength);
    if (next !== null) next = toStoredFormula(next, this.order);
    if (next !== null && next.length > SYNC_LIMITS.maxValueLength) {
      // Naming an inserted row costs 32 characters per reference. Better to say so than to cut a formula short.
      this._problem.set('That formula is too long once its references are expanded, so it was not saved.');
      return;
    }
    if ((this.cells.get(handle, col)?.value ?? null) === next) return; // no-op edits create no ops

    const op: CellOp = { rowId, col, value: next, ts: this.hlc.tick() };
    this.cells.apply({ row: handle, col, value: next, ts: op.ts });
    this.feedFormulas([{ row, col, raw: next === null ? null : this.asTyped(next) }]);
    this._version.update((v) => v + 1);

    this.pending.set(wireKey(rowId, col), op);
    this._pendingCount.set(this.pending.size + this.pendingRows.size);
    this.scheduleFlush();
    this.scheduleOutboxPersist();
  }

  /**
   * Inserts `count` empty rows just above the row that is now at position `row` (position
   * `dims().rows` adds at the end). Returns the position of the first new row.
   *
   * Nothing is renumbered: each new row gets a key that sorts between its neighbours (see
   * fractional-index.ts), so no other row is touched, and two people inserting at once simply
   * both get their rows.
   */
  insertRows(row: number, count: number): number {
    const at = Math.min(Math.max(row, 0), this.order.count);
    const keys = this.order.keysForInsert(at, Math.min(Math.max(count, 1), MAX_ROWS_PER_INSERT));

    for (const key of keys) {
      const rowId = newRowId();
      this.order.insert(rowId, key);
      this.pendingRows.set(rowId, { rowId, key });
    }

    this._layoutVersion.update((v) => v + 1);
    this.resetFormulas();
    this._version.update((v) => v + 1);
    this._pendingCount.set(this.pending.size + this.pendingRows.size);
    this.scheduleFlush();
    this.scheduleOutboxPersist();
    return at;
  }

  /** Shares your selected cell with others, throttled so holding an arrow key doesn't flood the hub. */
  shareSelection(row: number, col: number): void {
    const rowId = this.order.idAt(row);
    if (rowId !== undefined) this.shareSelectionOf(rowId, col);
  }

  private shareSelectionOf(rowId: string, col: number): void {
    this.lastSelection = { rowId, col };
    if (this.selectionTimer !== undefined) return;
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = undefined;
      const latest = this.lastSelection;
      if (latest && this._state() === 'live') {
        this.connection.send('SelectCell', latest.rowId, latest.col).catch(() => undefined);
      }
    }, PRESENCE_THROTTLE_MS);
  }

  // ----- sync internals --------------------------------------------------------------------

  /**
   * Merges rows and cells from the server (or our own unsent ones, at join) into this replica.
   * Rows go first: a cell needs its row, and both arrive in one message.
   */
  private mergeRemote(rows: readonly RowOp[], ops: readonly CellOp[], { flash, reset = false }: { flash: boolean; reset?: boolean }): void {
    let rowsAdded = false;
    for (const row of rows) if (this.order.insert(row.rowId, row.key)) rowsAdded = true;
    if (rowsAdded) this._layoutVersion.update((v) => v + 1);

    const changed: { op: CellOp; handle: number }[] = [];
    for (const op of ops) {
      this.hlc.receive(op.ts); // so our next edit sorts after everything we've seen
      const handle = this.order.handleOf(op.rowId);
      if (handle < 0) continue; // a row this replica has never heard of; the server sends a row before any cell in it
      if (this.cells.apply({ row: handle, col: op.col, value: op.value, ts: op.ts })) changed.push({ op, handle });
    }
    if (!rowsAdded && !reset && changed.length === 0) return;

    if (rowsAdded || reset) {
      // Rows moved (or the sheet just opened), so every cell has a new number: start the calculator over.
      this.resetFormulas();
    } else {
      // One batch, so a burst of remote edits recalculates once, not per cell.
      this.feedFormulas(
        changed.map(({ op, handle }) => ({
          row: this.order.indexOfHandle(handle),
          col: op.col,
          raw: op.value === null ? null : this.asTyped(op.value),
        })),
      );
    }
    this._version.update((v) => v + 1);
    if (flash) this.flash(changed.map(({ op, handle }) => ({ handle, col: op.col, nodeId: op.ts.nodeId })));
  }

  private flash(cells: readonly { handle: number; col: number; nodeId: string }[]): void {
    const colorByNode = new Map(this.peers().map((p) => [p.nodeId, p.color]));
    const batch = ++this.flashBatch;

    this._flashes.update((current) => {
      const next = new Map(current);
      for (const c of cells) next.set(cellKey(c.handle, c.col), { color: colorByNode.get(c.nodeId) ?? null, batch });
      return next;
    });

    setTimeout(() => {
      this._flashes.update((current) => {
        const next = new Map(current);
        for (const [key, entry] of current) if (entry.batch === batch) next.delete(key);
        return next;
      });
    }, FLASH_MS);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // Microtask: a paste that sets 300 cells in one go ends up in one batch, not 300 calls.
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while ((this.pending.size > 0 || this.pendingRows.size > 0) && this._state() === 'live') {
        const batch = this.nextBatch();
        const result = await this.connection.invoke<ApplyResult>('ApplyOps', batch.rows, batch.cells);

        // A row insert never changes once made, so once sent it is done.
        for (const row of batch.rows) this.pendingRows.delete(row.rowId);
        for (const op of batch.cells) {
          const key = wireKey(op.rowId, op.col);
          // Only clear it if you haven't edited the same cell again while this batch was in flight.
          if (this.pending.get(key) === op) this.pending.delete(key);
        }
        this._pendingCount.set(this.pending.size + this.pendingRows.size);
        this.scheduleOutboxPersist();

        if (result.rejected.length > 0) this._problem.set(this.describeRejection(batch, result));
      }
    } catch {
      // Connection dropped mid-flight. The ops are still in `pending`; the reconnect handler
      // flushes them again, and resending is safe because merges are idempotent.
    } finally {
      this.flushing = false;
    }
  }

  private scheduleOutboxPersist(): void {
    if (this.outboxPersistScheduled) return;
    this.outboxPersistScheduled = true;
    // Same microtask-batching as scheduleFlush: a paste that sets thousands of cells writes the
    // outbox once, not once per cell.
    queueMicrotask(() => {
      this.outboxPersistScheduled = false;
      this.persistOutboxNow();
    });
  }

  private persistOutboxNow(): void {
    void this.outbox.persist(this.sheetId, this.identity.nodeId, [...this.pending.values()], [...this.pendingRows.values()]);
  }

  /** Rows first, then cells, within the server's limits. Row inserts must never trail the edits that need them. */
  private nextBatch(): { rows: RowOp[]; cells: CellOp[] } {
    const rows: RowOp[] = [];
    const cells: CellOp[] = [];
    let count = 0;
    let chars = 0;

    for (const row of this.pendingRows.values()) {
      if (count >= SYNC_LIMITS.maxOpsPerBatch) break;
      rows.push(row);
      count++;
      chars += row.key.length + 96;
    }

    for (const op of this.pending.values()) {
      const size = (op.value?.length ?? 0) + 96; // rough JSON overhead per op
      if (count > 0 && (count >= SYNC_LIMITS.maxOpsPerBatch || chars + size > SYNC_LIMITS.maxBatchChars)) break;
      cells.push(op);
      count++;
      chars += size;
    }
    return { rows, cells };
  }

  /** Words the first refused edit. The server numbers rejections across the batch: rows first, then cells. */
  private describeRejection(batch: { rows: RowOp[]; cells: CellOp[] }, result: ApplyResult): string {
    const first = result.rejected[0];
    const n = result.rejected.length;
    const what = n === 1 ? 'an edit' : `${n} edits`;

    let where = 'a new row';
    if (first.index >= batch.rows.length) {
      const op = batch.cells[first.index - batch.rows.length];
      const row = this.order.indexOf(op.rowId);
      where = row >= 0 ? `row ${row + 1}` : 'a row that no longer exists';
    }
    return `The server refused ${what} (first at ${where}, reason: ${first.reason}). Those cells may differ from what others see.`;
  }
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // SignalR prefixes hub errors with this; the rest is the server's own wording.
  return text.replace(/^.*HubException: /, '');
}
