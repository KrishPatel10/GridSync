import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  IRetryPolicy,
  LogLevel,
} from '@microsoft/signalr';
import { SheetCalculator } from '../formulas/sheet-calculator';
import { HybridLogicalClock } from './hlc';
import { createIdentity } from './identity';
import { cellKey, LwwCellMap } from './lww-map';
import {
  ApplyResult,
  CellOp,
  ConnectionState,
  JoinResult,
  SYNC_LIMITS,
  UserPresence,
} from './sync.models';

/** Keep retrying forever, backing off to one attempt every 10 seconds. */
const retryForever: IRetryPolicy = {
  nextRetryDelayInMilliseconds: ({ previousRetryCount }) => Math.min(500 * 2 ** previousRetryCount, 10_000),
};

const FLASH_MS = 1_400;
const PRESENCE_THROTTLE_MS = 60;
const NO_PEERS: readonly UserPresence[] = [];

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
  private readonly cells = new LwwCellMap();
  /**
   * Turns the raw text in `cells` into computed values (formulas). Only raw text is synced; every
   * replica derives the same values locally. It is fed from every place `cells` changes.
   */
  private readonly calculator = new SheetCalculator();
  /** Unsent local edits, one per cell. A newer edit to the same cell replaces the older one. */
  private readonly pending = new Map<number, CellOp>();
  private readonly connection: HubConnection;

  private sheetId = 'demo';
  private hasJoinedOnce = false;
  private userWantsOffline = false;
  private flushing = false;
  private flushScheduled = false;
  private startAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSelection: { row: number; col: number } | undefined;
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  private flashBatch = 0;

  private readonly _version = signal(0);
  private readonly _state = signal<ConnectionState>('connecting');
  private readonly _dims = signal({ rows: 0, cols: 0 });
  private readonly _peers = signal<ReadonlyMap<string, UserPresence>>(new Map());
  private readonly _pendingCount = signal(0);
  private readonly _problem = signal<string | null>(null);
  private readonly _userOffline = signal(false);
  private readonly _flashes = signal<ReadonlyMap<number, { color: string | null; batch: number }>>(new Map());

  /** Bumps on every change to cell contents; templates read it to know when to re-render. */
  readonly version = this._version.asReadonly();
  readonly state = this._state.asReadonly();
  readonly dims = this._dims.asReadonly();
  readonly pendingCount = this._pendingCount.asReadonly();
  /** Latest thing that went wrong, phrased for the person using the sheet. */
  readonly problem = this._problem.asReadonly();
  /** True when the person chose "Go offline", as opposed to the network dropping. */
  readonly userOffline = this._userOffline.asReadonly();
  readonly peers = computed(() => [...this._peers().values()]);
  readonly filledCount = computed(() => {
    this._version();
    return this.cells.filledCount;
  });

  /** Other people's selections, indexed by cell for O(1) lookup while rendering. */
  private readonly peersByCell = computed(() => {
    const byCell = new Map<number, UserPresence[]>();
    for (const peer of this._peers().values()) {
      if (peer.row === null || peer.col === null) continue;
      const key = cellKey(peer.row, peer.col);
      const list = byCell.get(key);
      if (list) list.push(peer);
      else byCell.set(key, [peer]);
    }
    return byCell;
  });

  constructor() {
    this.connection = new HubConnectionBuilder()
      .withUrl('/hubs/sheet')
      .withAutomaticReconnect(retryForever)
      .configureLogging(LogLevel.Warning)
      .build();

    // Handlers use block bodies on purpose: if a handler returns a value, the SignalR client
    // treats it as a reply to the server and logs an error.
    this.connection.on('opsApplied', (ops: CellOp[]) => {
      this.mergeRemote(ops, { flash: true });
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

    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.retryTimer);
      clearTimeout(this.selectionTimer);
      void this.connection.stop();
    });
  }

  // ----- lifecycle -------------------------------------------------------------------------

  connect(sheetId: string): void {
    this.sheetId = sheetId;
    void this.start();
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
      );

      this._dims.set({ rows: joined.rows, cols: joined.cols });
      this.calculator.setDimensions(joined.rows, joined.cols); // before the snapshot, so references resolve
      this._peers.set(new Map(joined.users.map((u) => [u.connectionId, u])));
      // After a reconnect, flash whatever other people changed while we were away.
      this.mergeRemote(joined.cells, { flash: this.hasJoinedOnce });
      this.hasJoinedOnce = true;
      this._state.set('live');
      this._problem.set(null);

      if (this.lastSelection) this.shareSelection(this.lastSelection.row, this.lastSelection.col);
      await this.flush();
    } catch (err) {
      this._problem.set(`Couldn't open sheet "${this.sheetId}": ${messageOf(err)}`);
      void this.connection.stop();
    }
  }

  // ----- reading ---------------------------------------------------------------------------

  /** The raw text of a cell: what was typed, and what the formula bar and the editor show. */
  valueAt(row: number, col: number): string {
    this._version(); // register the dependency for whoever is rendering
    return this.cells.get(row, col)?.value ?? '';
  }

  /** What the grid shows in a cell: a formula's computed result, or the raw text for anything else. */
  displayAt(row: number, col: number): string {
    this._version();
    return this.calculator.formulaDisplayAt(row, col) ?? this.cells.get(row, col)?.value ?? '';
  }

  peersAt(row: number, col: number): readonly UserPresence[] {
    return this.peersByCell().get(cellKey(row, col)) ?? NO_PEERS;
  }

  /** The ink color of whoever just changed this cell, or undefined if nothing just changed. */
  flashAt(row: number, col: number): string | null | undefined {
    return this._flashes().get(cellKey(row, col))?.color;
  }

  // ----- writing ---------------------------------------------------------------------------

  /** Sets a cell. An empty string clears it. Applied locally at once, synced in the background. */
  setCell(row: number, col: number, value: string | null): void {
    const next = value === null || value === '' ? null : value.slice(0, SYNC_LIMITS.maxValueLength);
    if ((this.cells.get(row, col)?.value ?? null) === next) return; // no-op edits create no ops

    const op: CellOp = { row, col, value: next, ts: this.hlc.tick() };
    this.cells.apply(op);
    this.calculator.applyChanges([{ row, col, raw: next }]);
    this._version.update((v) => v + 1);

    this.pending.set(cellKey(row, col), op);
    this._pendingCount.set(this.pending.size);
    this.scheduleFlush();
  }

  /** Shares your selected cell with others, throttled so holding an arrow key doesn't flood the hub. */
  shareSelection(row: number, col: number): void {
    this.lastSelection = { row, col };
    if (this.selectionTimer !== undefined) return;
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = undefined;
      const latest = this.lastSelection;
      if (latest && this._state() === 'live') {
        this.connection.send('SelectCell', latest.row, latest.col).catch(() => undefined);
      }
    }, PRESENCE_THROTTLE_MS);
  }

  // ----- sync internals --------------------------------------------------------------------

  private mergeRemote(ops: readonly CellOp[], { flash }: { flash: boolean }): void {
    const changed: CellOp[] = [];
    for (const op of ops) {
      this.hlc.receive(op.ts); // so our next edit sorts after everything we've seen
      if (this.cells.apply(op)) changed.push(op);
    }
    if (changed.length === 0) return;

    // One batch, so a join snapshot or a burst of remote edits recalculates once, not per cell.
    this.calculator.applyChanges(changed.map((op) => ({ row: op.row, col: op.col, raw: op.value })));
    this._version.update((v) => v + 1);
    if (flash) this.flash(changed);
  }

  private flash(ops: readonly CellOp[]): void {
    const colorByNode = new Map(this.peers().map((p) => [p.nodeId, p.color]));
    const batch = ++this.flashBatch;

    this._flashes.update((current) => {
      const next = new Map(current);
      for (const op of ops) next.set(cellKey(op.row, op.col), { color: colorByNode.get(op.ts.nodeId) ?? null, batch });
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
      while (this.pending.size > 0 && this._state() === 'live') {
        const batch = this.nextBatch();
        const result = await this.connection.invoke<ApplyResult>('ApplyOps', batch);

        for (const op of batch) {
          const key = cellKey(op.row, op.col);
          // Only clear it if you haven't edited the same cell again while this batch was in flight.
          if (this.pending.get(key) === op) this.pending.delete(key);
        }
        this._pendingCount.set(this.pending.size);

        if (result.rejected.length > 0) {
          const first = result.rejected[0];
          const op = batch[first.index];
          this._problem.set(
            `The server refused ${result.rejected.length === 1 ? 'an edit' : `${result.rejected.length} edits`}` +
              ` (first at row ${op.row + 1}, reason: ${first.reason}). Those cells may differ from what others see.`,
          );
        }
      }
    } catch {
      // Connection dropped mid-flight. The ops are still in `pending`; the reconnect handler
      // flushes them again, and resending is safe because merges are idempotent.
    } finally {
      this.flushing = false;
    }
  }

  private nextBatch(): CellOp[] {
    const batch: CellOp[] = [];
    let chars = 0;
    for (const op of this.pending.values()) {
      const size = (op.value?.length ?? 0) + 96; // rough JSON overhead per op
      if (batch.length > 0 && (batch.length >= SYNC_LIMITS.maxOpsPerBatch || chars + size > SYNC_LIMITS.maxBatchChars)) break;
      batch.push(op);
      chars += size;
    }
    return batch;
  }
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // SignalR prefixes hub errors with this; the rest is the server's own wording.
  return text.replace(/^.*HubException: /, '');
}
