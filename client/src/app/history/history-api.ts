import { Injectable } from '@angular/core';
import type { HlcTimestamp } from '../sync/hlc';
import type { CellOp, RowOp } from '../sync/sync.models';

/**
 * The edit that produced a step. GridSync.Api.Persistence.HistoryOp. A row insert has no timestamp
 * or author: the log stores a row without them.
 */
export interface HistoryOp {
  readonly kind: 'cell' | 'row';
  readonly rowId: string;
  readonly col: number;
  readonly value: string | null;
  readonly ts: HlcTimestamp | null;
}

/** GridSync.Api.Persistence.HistoryStep: the sheet after its first `step` edits. */
export interface HistoryStep {
  readonly step: number;
  /** How many edits the sheet had when this was asked. */
  readonly count: number;
  /** The rows the sheet started with; inserted ones are in `insertedRows`. */
  readonly rows: number;
  readonly cols: number;
  readonly insertedRows: RowOp[];
  readonly cells: CellOp[];
  readonly op: HistoryOp | null;
}

/** Reads a sheet's past from the server. Read-only: nothing here can change a sheet. */
@Injectable({ providedIn: 'root' })
export class HistoryApi {
  /** How many edits the sheet has had: the history slider runs from 0 to this. */
  async count(sheetId: string, signal?: AbortSignal): Promise<number> {
    const summary = await this.get<{ count: number }>(`/api/sheets/${encodeURIComponent(sheetId)}/history`, signal);
    return summary.count;
  }

  /** The sheet as it stood after its first `step` edits (0 is the empty sheet). */
  step(sheetId: string, step: number, signal?: AbortSignal): Promise<HistoryStep> {
    return this.get<HistoryStep>(`/api/sheets/${encodeURIComponent(sheetId)}/history/${step}`, signal);
  }

  private async get<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`The server could not load this history (${response.status}).`);
    return (await response.json()) as T;
  }
}
