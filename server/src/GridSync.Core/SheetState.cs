using System.Collections.Concurrent;

namespace GridSync.Core;

/// <summary>
/// One sheet's cells as a map of last-writer-wins (LWW) registers.
///
/// Merge rule: for each cell, the write with the greatest <see cref="HlcTimestamp"/> wins.
/// That rule is commutative (order of arrival doesn't matter), idempotent (applying the same op
/// twice changes nothing), and associative, so any two replicas that have seen the same set of
/// ops end up identical. That's what lets clients edit optimistically and retry freely.
/// </summary>
public sealed class SheetState
{
    private readonly ConcurrentDictionary<CellKey, CellEntry> _cells = new();

    public SheetState(string id, SheetDimensions dimensions)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);
        Id = id;
        Dimensions = dimensions;
    }

    public string Id { get; }
    public SheetDimensions Dimensions { get; }

    /// <summary>Number of cells that currently hold a value (tombstones excluded).</summary>
    public int FilledCount => _cells.Values.Count(e => e.Value is not null);

    /// <summary>
    /// Applies an op if it beats the current value for that cell.
    /// Returns true when the op won (state changed), false when it was stale or a duplicate.
    /// </summary>
    /// <remarks>
    /// Lock-free: many hub calls can apply ops to the same sheet concurrently. If another thread
    /// changes the cell between our read and our write, TryAdd/TryUpdate fails and we re-evaluate
    /// against the new value instead of blindly overwriting it.
    /// </remarks>
    public bool Apply(CellOp op)
    {
        var key = new CellKey(op.Row, op.Col);
        var incoming = new CellEntry(op.Value, op.Ts);

        while (true)
        {
            if (!_cells.TryGetValue(key, out var current))
            {
                if (_cells.TryAdd(key, incoming)) return true;
                continue; // someone else created the cell first; compare against theirs
            }

            if (incoming.Ts <= current.Ts) return false; // stale or duplicate

            if (_cells.TryUpdate(key, incoming, current)) return true;
            // current changed under us; loop and compare again
        }
    }

    public CellEntry? Get(int row, int col) =>
        _cells.TryGetValue(new CellKey(row, col), out var entry) ? entry : null;

    /// <summary>
    /// Every cell's winning write, tombstones included. A client that merges this snapshot with
    /// the same LWW rule converges with the server even if it has unsynced local edits.
    /// </summary>
    public IReadOnlyList<CellOp> Snapshot() =>
        _cells.Select(kv => new CellOp(kv.Key.Row, kv.Key.Col, kv.Value.Value, kv.Value.Ts)).ToList();
}
