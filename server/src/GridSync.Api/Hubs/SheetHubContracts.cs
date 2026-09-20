using GridSync.Api.Sheets;
using GridSync.Core;

namespace GridSync.Api.Hubs;

/// <summary>Methods the server calls on browsers. Names must match the handlers in sheet-sync.service.ts.</summary>
public interface ISheetClient
{
    Task OpsApplied(IReadOnlyList<CellOp> ops);
    Task PresenceChanged(UserPresence user);
    Task PresenceLeft(string connectionId);
}

public sealed record JoinResult(
    string SheetId,
    int Rows,
    int Cols,
    string ConnectionId,
    IReadOnlyList<CellOp> Cells,
    IReadOnlyList<UserPresence> Users);

/// <param name="Accepted">Ops that won and were broadcast.</param>
/// <param name="Stale">Valid ops that lost to a newer write already on the server. Not an error.</param>
/// <param name="Rejected">Ops that failed validation, by their index in the batch.</param>
public sealed record ApplyResult(int Accepted, int Stale, IReadOnlyList<RejectedOp> Rejected);

public sealed record RejectedOp(int Index, string Reason);
