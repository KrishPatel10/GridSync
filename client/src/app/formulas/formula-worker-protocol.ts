import { FormulaUpdate, RawChange, SheetCalculator } from './sheet-calculator';

/**
 * The messages between the page and the formula worker. Everything in them is plain data
 * (numbers, strings, arrays), so it survives structured cloning, which is how postMessage copies
 * things between threads.
 *
 * This file is imported by the worker too, so it must not import anything from Angular.
 */
export type WorkerRequest =
  | { readonly type: 'dimensions'; readonly rows: number; readonly cols: number }
  | { readonly type: 'changes'; readonly changes: readonly RawChange[] };

export interface WorkerResponse {
  readonly type: 'updates';
  readonly updates: readonly FormulaUpdate[];
}

/**
 * What the worker does with one message. Kept as a plain function, separate from the worker's
 * event plumbing, so it can be tested without a real worker.
 */
export function handleRequest(calculator: SheetCalculator, request: WorkerRequest): FormulaUpdate[] {
  switch (request.type) {
    case 'dimensions':
      return calculator.setDimensions(request.rows, request.cols);
    case 'changes':
      return calculator.applyChanges(request.changes);
  }
}
