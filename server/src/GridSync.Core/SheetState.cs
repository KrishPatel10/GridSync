using System.Collections.Concurrent;

namespace GridSync.Core;

/// <summary>
/// One sheet: its rows and its cells.
///
/// Cells are last-writer-wins (LWW) registers. For each cell, the write with the greatest
/// <see cref="HlcTimestamp"/> wins. That rule is commutative (order of arrival doesn't matter),
/// idempotent (applying the same op twice changes nothing), and associative, so any two replicas
/// that have seen the same set of ops end up identical. That's what lets clients edit optimistically
/// and retry freely.
///
/// Rows are a grow-only set: a row, once inserted, exists forever with the key it was given, so
/// merging is a union and order doesn't matter either. The sheet's initial rows are implicit and
/// are not stored here; only inserted rows are.
/// </summary>
public sealed class SheetState
{
    private readonly ConcurrentDictionary<CellKey, CellEntry> _cells = new();
    private readonly ConcurrentDictionary<string, string> _insertedRows = new(StringComparer.Ordinal);

    public SheetState(string id, SheetDimensions dimensions)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);
        Id = id;
        Dimensions = dimensions;
    }

    public string Id { get; }

    /// <summary>The rows and columns the sheet started with. Inserted rows are on top of this.</summary>
    public SheetDimensions Dimensions { get; }

    /// <summary>Number of cells that currently hold a value (tombstones excluded).</summary>
    public int FilledCount => _cells.Values.Count(e => e.Value is not null);

    public int InsertedRowCount => _insertedRows.Count;

    /// <summary>Does this row exist: one of the initial rows, or one that has been inserted?</summary>
    public bool HasRow(string rowId) =>
        RowIds.TryParseBaseRow(rowId, out var index) ? index < Dimensions.Rows : _insertedRows.ContainsKey(rowId);

    /// <summary>
    /// Adds a row. Returns true if it is new, false if a row with that id already exists (a duplicate
    /// delivery, which is harmless). A row's key never changes, so a second op for the same id with a
    /// different key is ignored, first one wins: ids are random, so that only happens to a misbehaving client.
    /// </summary>
    public bool InsertRow(RowOp op) => _insertedRows.TryAdd(op.RowId, op.Key);

    public string? RowKey(string rowId) => _insertedRows.TryGetValue(rowId, out var key) ? key : null;

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
        var key = new CellKey(op.RowId, op.Col);
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

    public CellEntry? Get(string rowId, int col) =>
        _cells.TryGetValue(new CellKey(rowId, col), out var entry) ? entry : null;

    /// <summary>
    /// Every cell's winning write, tombstones included. A client that merges this snapshot with
    /// the same LWW rule converges with the server even if it has unsynced local edits.
    /// </summary>
    public IReadOnlyList<CellOp> Snapshot() =>
        _cells.Select(kv => new CellOp(kv.Key.RowId, kv.Key.Col, kv.Value.Value, kv.Value.Ts)).ToList();

    /// <summary>Every inserted row. Unordered: the order is a function of the keys, each replica computes it.</summary>
    public IReadOnlyList<RowOp> RowSnapshot() =>
        _insertedRows.Select(kv => new RowOp(kv.Key, kv.Value)).ToList();
}
