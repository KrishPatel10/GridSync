/// <reference lib="webworker" />
import { handleRequest, WorkerRequest, WorkerResponse } from './formula-worker-protocol';
import { SheetCalculator } from './sheet-calculator';

/**
 * Runs the sheet calculator off the UI thread, so recalculating thousands of cells never freezes
 * scrolling or typing. The page sends raw cell changes; this replies with the display text of
 * every formula that changed. Messages are handled strictly in order, and each gets exactly one
 * reply, in order, even an empty one.
 */
const calculator = new SheetCalculator();

addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const response: WorkerResponse = { type: 'updates', updates: handleRequest(calculator, event.data) };
  postMessage(response);
});
