using System.Text.Json;
using GridSync.Core;

namespace GridSync.Api.Persistence;

/// <summary>
/// Rebuilds a sheet's in-memory state from what's persisted: a snapshot (if any) plus the log
/// entries written after it.
///
/// The interesting part is what this does NOT do: it never special-cases "is this entry newer
/// than the snapshot?" Both the snapshot's cells and the tail entries are fed through the same
/// <see cref="SheetState.Apply"/> the hub uses for live edits, and that merge is already the
/// source of truth for "which value wins." A tail entry can end up older than what the snapshot
/// already holds for its cell (two clients racing, one with a slightly-behind clock; see the
/// clock-skew guard in OpValidator), and Apply simply ignores it, exactly as it would live. So a
/// restore can never produce a sheet a live sequence of the same ops couldn't also have produced.
/// </summary>
public static class SheetRestorer
{
    public static SheetState Restore(string sheetId, SheetDimensions dims, SheetSnapshot? snapshot, IReadOnlyList<OpLogEntry> tail)
    {
        var state = new SheetState(sheetId, dims);

        if (snapshot is not null)
        {
            var cells = JsonSerializer.Deserialize<List<CellOp>>(snapshot.CellsJson) ?? [];
            foreach (var op in cells) state.Apply(op);
        }

        foreach (var entry in tail) state.Apply(ToCellOp(entry));

        return state;
    }

    /// <summary>Loads whatever is persisted for a sheet and restores it. Empty (never persisted) is not an error.</summary>
    public static async Task<SheetState> RestoreAsync(
        IPersistenceStore store, string sheetId, SheetDimensions dims, CancellationToken ct = default)
    {
        var snapshot = await store.GetSnapshotAsync(sheetId, ct);
        var tail = await store.GetTailAsync(sheetId, snapshot?.UpToOpId ?? 0, ct);
        return Restore(sheetId, dims, snapshot, tail);
    }

    public static SheetSnapshot ToSnapshot(SheetState state, long upToOpId, TimeProvider time) => new()
    {
        SheetId = state.Id,
        CellsJson = JsonSerializer.Serialize(state.Snapshot()),
        UpToOpId = upToOpId,
        WrittenAtUtc = time.GetUtcNow(),
    };

    public static OpLogEntry ToLogEntry(string sheetId, CellOp op) => new()
    {
        SheetId = sheetId,
        Row = op.Row,
        Col = op.Col,
        Value = op.Value,
        WallMs = op.Ts.WallMs,
        Counter = op.Ts.Counter,
        NodeId = op.Ts.NodeId,
    };

    private static CellOp ToCellOp(OpLogEntry entry) =>
        new(entry.Row, entry.Col, entry.Value, new HlcTimestamp(entry.WallMs, entry.Counter, entry.NodeId));
}