import { HlcTimestamp } from './hlc';

/** Wire shapes. Each one mirrors a C# record in the server (see comments for which). */

/**
 * The version of these messages. Sent when joining; a server that speaks another version turns the
 * page away with a reload prompt instead of misreading it. Keep in step with Protocol.Version in
 * SheetHubContracts.cs. Version 2 addresses cells by row id and adds row inserts.
 */
export const PROTOCOL_VERSION = 2;

/**
 * GridSync.Core.CellOp. A null value means the cell was cleared. The row is named by its stable id
 * ("b4" for one of the initial rows, 32 hex digits for an inserted one), never by its number,
 * because a row's number changes when someone inserts a row above it.
 */
export interface CellOp {
  readonly rowId: string;
  readonly col: number;
  readonly value: string | null;
  readonly ts: HlcTimestamp;
}

/** GridSync.Core.RowOp: "a row with this id exists and sorts at this key". Rows are never changed or removed. */
export interface RowOp {
  readonly rowId: string;
  readonly key: string;
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
  readonly rowId: string | null;
  readonly col: number | null;
}

/** GridSync.Api.Hubs.JoinResult. `rows` counts the initial rows only; inserted ones are in `insertedRows`. */
export interface JoinResult {
  readonly sheetId: string;
  readonly rows: number;
  readonly cols: number;
  readonly connectionId: string;
  readonly insertedRows: RowOp[];
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
