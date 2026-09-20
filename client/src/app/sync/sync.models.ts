import { HlcTimestamp } from './hlc';

/** Wire shapes. Each one mirrors a C# record in the server (see comments for which). */

/** GridSync.Core.CellOp. A null value means the cell was cleared. */
export interface CellOp {
  readonly row: number;
  readonly col: number;
  readonly value: string | null;
  readonly ts: HlcTimestamp;
}

/** GridSync.Core.CellEntry: the winning write for one cell. */
export interface CellEntry {
  readonly value: string | null;
  readonly ts: HlcTimestamp;
}

/** GridSync.Api.Sheets.UserPresence */
export interface UserPresence {
  readonly connectionId: string;
  readonly nodeId: string;
  readonly name: string;
  readonly color: string;
  readonly row: number | null;
  readonly col: number | null;
}

/** GridSync.Api.Hubs.JoinResult */
export interface JoinResult {
  readonly sheetId: string;
  readonly rows: number;
  readonly cols: number;
  readonly connectionId: string;
  readonly cells: CellOp[];
  readonly users: UserPresence[];
}

/** GridSync.Api.Hubs.ApplyResult */
export interface ApplyResult {
  readonly accepted: number;
  readonly stale: number;
  readonly rejected: { readonly index: number; readonly reason: string }[];
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** Must match GridSync:MaxValueLength and MaxOpsPerBatch in the API's appsettings.json. */
export const SYNC_LIMITS = {
  maxValueLength: 10_000,
  maxOpsPerBatch: 500,
  /** Keep each batch comfortably under the hub's 512 KB MaximumReceiveMessageSize. */
  maxBatchChars: 256_000,
} as const;
