using System.Collections.Concurrent;

namespace GridSync.Api.Sheets;

/// <summary>Who is looking at which sheet, and which cell they have selected.</summary>
/// <param name="NodeId">The replica id this user stamps on its edits, so others can tell whose edit just landed.</param>
public sealed record UserPresence(string ConnectionId, string NodeId, string Name, string Color, int? Row, int? Col);

public sealed record PresenceSession(string SheetId, UserPresence User);

/// <summary>
/// Tracks one session per SignalR connection. A connection is joined to at most one sheet;
/// the hub uses that to decide which group an edit belongs to, so clients never pass a sheet id
/// with their edits (and can't write to a sheet they didn't join).
/// </summary>
public sealed class PresenceTracker
{
    private readonly ConcurrentDictionary<string, PresenceSession> _sessions = new(StringComparer.Ordinal);

    public PresenceSession Join(string connectionId, string sheetId, string nodeId, string name, string color)
    {
        var session = new PresenceSession(sheetId, new UserPresence(connectionId, nodeId, name, color, null, null));
        _sessions[connectionId] = session;
        return session;
    }

    public PresenceSession? Get(string connectionId) =>
        _sessions.TryGetValue(connectionId, out var session) ? session : null;

    public PresenceSession? UpdateSelection(string connectionId, int row, int col)
    {
        while (_sessions.TryGetValue(connectionId, out var current))
        {
            var updated = current with { User = current.User with { Row = row, Col = col } };
            if (_sessions.TryUpdate(connectionId, updated, current)) return updated;
        }

        return null; // not joined (or disconnected mid-call)
    }

    public PresenceSession? Leave(string connectionId) =>
        _sessions.TryRemove(connectionId, out var session) ? session : null;

    /// <summary>O(connections). Fine at demo scale; index by sheet if this ever gets hot.</summary>
    public IReadOnlyList<UserPresence> UsersIn(string sheetId, string exceptConnectionId) =>
        _sessions.Values
            .Where(s => s.SheetId == sheetId && s.User.ConnectionId != exceptConnectionId)
            .Select(s => s.User)
            .ToList();
}
