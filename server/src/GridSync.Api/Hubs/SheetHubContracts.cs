using GridSync.Api.Sheets;
using GridSync.Core;

namespace GridSync.Api.Hubs;

/// <summary>Methods the server calls on browsers. Names must match the handlers in sheet-sync.service.ts.</summary>
public interface ISheetClient
{
    Task OpsApplied(IReadOnlyList<RowOp> rows, IReadOnlyList<CellOp> cells);
    Task PresenceChanged(UserPresence user);
    Task PresenceLeft(string connectionId);
}

/// <summary>
/// The wire protocol version. Version 2 addresses cells by row id and adds row inserts. A client
/// that sends a different number is told to reload, instead of misreading the other side's messages.
/// Keep in step with PROTOCOL_VERSION in sync.models.ts.
/// </summary>
public static class Protocol
{
    public const int Version = 2;
}

/// <param name="Rows">How many rows the sheet started with. Inserted rows are in <paramref name="InsertedRows"/>.</param>
public sealed record JoinResult(
    string SheetId,
    int Rows,
    int Cols,
    string ConnectionId,
    IReadOnlyList<RowOp> InsertedRows,
    IReadOnlyList<CellOp> Cells,
    IReadOnlyList<UserPresence> Users);

/// <param name="Accepted">Ops that won and were broadcast.</param>
/// <param name="Stale">Valid ops that lost to a newer write already on the server, or rows it already had. Not an error.</param>
/// <param name="Rejected">Ops that failed validation, by their index in the batch (row inserts first, then cell edits).</param>
public sealed record ApplyResult(int Accepted, int Stale, IReadOnlyList<RejectedOp> Rejected);

public sealed record RejectedOp(int Index, string Reason);
