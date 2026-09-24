using System.Text.RegularExpressions;
using GridSync.Api.Persistence;
using GridSync.Api.Sheets;
using GridSync.Core;
using Microsoft.AspNetCore.SignalR;

namespace GridSync.Api.Hubs;

public sealed partial class SheetHub(
    SheetStore store,
    PresenceTracker presence,
    OpValidator validator,
    OpLogChannel opLog,
    ILogger<SheetHub> logger) : Hub<ISheetClient>
{
    private const string DefaultColor = "#2456D6";
    private const int MaxNameLength = 32;

    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$")]
    private static partial Regex IdPattern();

    [GeneratedRegex("^#[0-9A-Fa-f]{6}$")]
    private static partial Regex ColorPattern();

    private static string GroupFor(string sheetId) => $"sheet:{sheetId}";

    /// <summary>
    /// Joins a sheet and returns its full state. The connection is added to the group BEFORE the
    /// snapshot is taken, so no edit can slip into the gap between "snapshot" and "subscribed".
    /// An edit landing in that window may arrive twice (in the snapshot and as a broadcast),
    /// which is harmless because LWW merges are idempotent.
    /// </summary>
    public async Task<JoinResult> JoinSheet(string sheetId, string nodeId, string name, string color)
    {
        if (string.IsNullOrEmpty(sheetId) || !IdPattern().IsMatch(sheetId))
            throw new HubException("Sheet names can use 1 to 64 letters, digits, hyphens, or underscores.");

        if (string.IsNullOrEmpty(nodeId) || !IdPattern().IsMatch(nodeId))
            throw new HubException("Node ids can use 1 to 64 letters, digits, hyphens, or underscores.");

        SheetState sheet;
        try
        {
            sheet = await store.GetOrCreateAsync(sheetId);
        }
        catch (SheetLimitReachedException ex)
        {
            throw new HubException(ex.Message);
        }

        var connectionId = Context.ConnectionId;
        if (presence.Get(connectionId) is { } previous && previous.SheetId != sheetId)
        {
            await Groups.RemoveFromGroupAsync(connectionId, GroupFor(previous.SheetId));
            await Clients.OthersInGroup(GroupFor(previous.SheetId)).PresenceLeft(connectionId);
        }

        await Groups.AddToGroupAsync(connectionId, GroupFor(sheetId));

        var session = presence.Join(connectionId, sheetId, nodeId, CleanName(name), CleanColor(color));
        await Clients.OthersInGroup(GroupFor(sheetId)).PresenceChanged(session.User);

        Log.Joined(logger, connectionId, sheetId);

        return new JoinResult(
            sheet.Id,
            sheet.Dimensions.Rows,
            sheet.Dimensions.Cols,
            connectionId,
            sheet.Snapshot(),
            presence.UsersIn(sheetId, exceptConnectionId: connectionId));
    }

    /// <summary>
    /// Applies a batch of edits. Winning ops are broadcast to everyone else on the sheet; stale ops
    /// (already beaten by a newer write) are counted but not broadcast, since every other replica
    /// either already has the newer value or will receive it.
    /// </summary>
    public async Task<ApplyResult> ApplyOps(CellOp?[] ops)
    {
        var session = presence.Get(Context.ConnectionId)
            ?? throw new HubException("Join a sheet before sending edits.");

        if (ops.Length > validator.Limits.MaxOpsPerBatch)
            throw new HubException($"Send at most {validator.Limits.MaxOpsPerBatch} edits per batch.");

        var sheet = store.Find(session.SheetId)
            ?? throw new HubException("This sheet is no longer available. Reload to rejoin.");

        var accepted = new List<CellOp>(ops.Length);
        var rejected = new List<RejectedOp>();
        var stale = 0;

        for (var i = 0; i < ops.Length; i++)
        {
            if (ops[i] is not { } op)
            {
                rejected.Add(new RejectedOp(i, "Empty edit"));
                continue;
            }

            var problem = validator.Validate(op, sheet.Dimensions);
            if (problem != OpRejection.None)
            {
                rejected.Add(new RejectedOp(i, problem.ToString()));
                continue;
            }

            // A connection may only stamp edits with its own node id. Otherwise a client could
            // borrow another replica's id to win tie-breaks or disguise whose edit it was.
            if (!string.Equals(op.Ts.NodeId, session.User.NodeId, StringComparison.Ordinal))
            {
                rejected.Add(new RejectedOp(i, "NodeIdMismatch"));
                continue;
            }

            if (sheet.Apply(op))
            {
                accepted.Add(op);
                opLog.Enqueue(sheet.Id, op); // write-behind: queued, not written here (see OpLogChannel)
            }
            else
            {
                stale++;
            }
        }

        if (accepted.Count > 0)
            await Clients.OthersInGroup(GroupFor(sheet.Id)).OpsApplied(accepted);

        Log.Applied(logger, sheet.Id, accepted.Count, stale, rejected.Count);
        return new ApplyResult(accepted.Count, stale, rejected);
    }

    /// <summary>Shares this user's selected cell so others can see where they are.</summary>
    public async Task SelectCell(int row, int col)
    {
        var current = presence.Get(Context.ConnectionId);
        if (current is null) return;

        var dims = store.Find(current.SheetId)?.Dimensions;
        if (dims is null || row < 0 || row >= dims.Value.Rows || col < 0 || col >= dims.Value.Cols) return;

        var updated = presence.UpdateSelection(Context.ConnectionId, row, col);
        if (updated is not null)
            await Clients.OthersInGroup(GroupFor(updated.SheetId)).PresenceChanged(updated.User);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        // SignalR removes the connection from its groups automatically; we only clean up presence.
        if (presence.Leave(Context.ConnectionId) is { } session)
            await Clients.Group(GroupFor(session.SheetId)).PresenceLeft(Context.ConnectionId);

        await base.OnDisconnectedAsync(exception);
    }

    private static string CleanName(string? name)
    {
        var trimmed = (name ?? string.Empty).Trim();
        if (trimmed.Length == 0) return "Guest";
        return trimmed.Length <= MaxNameLength ? trimmed : trimmed[..MaxNameLength];
    }

    private static string CleanColor(string? color) =>
        color is not null && ColorPattern().IsMatch(color) ? color : DefaultColor;
}

internal static partial class Log
{
    [LoggerMessage(Level = LogLevel.Information, Message = "Connection {ConnectionId} joined sheet {SheetId}")]
    public static partial void Joined(ILogger logger, string connectionId, string sheetId);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Sheet {SheetId}: {Accepted} accepted, {Stale} stale, {Rejected} rejected")]
    public static partial void Applied(ILogger logger, string sheetId, int accepted, int stale, int rejected);
}