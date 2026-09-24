import { InjectionToken } from '@angular/core';
import { handleRequest, WorkerRequest, WorkerResponse } from './formula-worker-protocol';
import { FormulaUpdate, RawChange, SheetCalculator } from './sheet-calculator';

/**
 * Where formulas get calculated. The sync service talks to this interface and does not care
 * whether the work happens in a Web Worker or right here on the page.
 *
 * Results come back through onUpdates, in the same order the requests were made. With a worker
 * they arrive a moment later; with the inline backend they arrive before the call returns.
 */
export interface FormulaBackend {
  /** Set by the owner. Called with every batch of changed formula displays. */
  onUpdates: (updates: readonly FormulaUpdate[]) => void;
  /** Set by the owner. Called at most once, if the backend can no longer be used (a worker that failed to load). */
  onFailure: () => void;

  setDimensions(rows: number, cols: number): void;
  applyChanges(changes: readonly RawChange[]): void;
  /** Replaces the whole sheet. For when rows have moved, so every cell has a new position. */
  reset(rows: number, cols: number, changes: readonly RawChange[]): void;
  dispose(): void;
}

/** Calculates on the calling thread. Used in tests, and as the fallback if a worker is unavailable. */
export class InlineFormulaBackend implements FormulaBackend {
  onUpdates: (updates: readonly FormulaUpdate[]) => void = () => undefined;
  onFailure: () => void = () => undefined;

  private readonly calculator = new SheetCalculator();

  setDimensions(rows: number, cols: number): void {
    this.deliver(handleRequest(this.calculator, { type: 'dimensions', rows, cols }));
  }

  applyChanges(changes: readonly RawChange[]): void {
    this.deliver(handleRequest(this.calculator, { type: 'changes', changes }));
  }

  reset(rows: number, cols: number, changes: readonly RawChange[]): void {
    this.deliver(handleRequest(this.calculator, { type: 'reset', rows, cols, changes }));
  }

  dispose(): void {
    // nothing to release
  }

  /** Every request is answered, even with nothing: see WorkerResponse. */
  private deliver(updates: readonly FormulaUpdate[]): void {
    this.onUpdates(updates);
  }
}

/** Calculates in a Web Worker, so the page stays responsive however many cells a change touches. */
export class WorkerFormulaBackend implements FormulaBackend {
  onUpdates: (updates: readonly FormulaUpdate[]) => void = () => undefined;
  onFailure: () => void = () => undefined;

  private readonly worker: Worker;

  constructor() {
    this.worker = new Worker(new URL('./formula.worker', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      this.onUpdates(event.data.updates);
    };
    this.worker.onerror = () => {
      this.onFailure();
    };
  }

  setDimensions(rows: number, cols: number): void {
    this.post({ type: 'dimensions', rows, cols });
  }

  applyChanges(changes: readonly RawChange[]): void {
    this.post({ type: 'changes', changes });
  }

  reset(rows: number, cols: number, changes: readonly RawChange[]): void {
    this.post({ type: 'reset', rows, cols, changes });
  }

  dispose(): void {
    this.worker.terminate();
  }

  private post(request: WorkerRequest): void {
    this.worker.postMessage(request);
  }
}

/**
 * A worker where the browser has them, and the inline backend everywhere else (tests, old
 * browsers). Adding ?formulas=inline to the page URL forces the inline backend, to compare the two
 * in the same browser or to rule the worker out while debugging.
 */
export function createFormulaBackend(): FormulaBackend {
  const forceInline = typeof location !== 'undefined' && new URLSearchParams(location.search).get('formulas') === 'inline';
  if (!forceInline && typeof Worker !== 'undefined') {
    try {
      return new WorkerFormulaBackend();
    } catch {
      // Could not start a worker (a restrictive page policy, say): fall through to inline.
    }
  }
  return new InlineFormulaBackend();
}

/** Injectable so a test can supply its own backend, for example one that answers asynchronously. */
export const FORMULA_BACKEND_FACTORY = new InjectionToken<() => FormulaBackend>('FORMULA_BACKEND_FACTORY', {
  providedIn: 'root',
  factory: () => createFormulaBackend,
});
