using GridSync.Api.Persistence;
using GridSync.Core;

namespace GridSync.Api.Tests.Persistence;

public class SheetRestorerTests
{
    private static readonly SheetDimensions Dims = new(100, 10);

    private static OpLogEntry Entry(long id, int row, int col, string? value, long wallMs, string node = "n") => new()
    {
        Id = id,
        SheetId = "demo",
        RowId = "b" + row,
        Col = col,
        Value = value,
        WallMs = wallMs,
        Counter = 0,
        NodeId = node,
    };

    [Fact]
    public void A_sheet_with_nothing_persisted_restores_empty()
    {
        var state = SheetRestorer.Restore("demo", Dims, snapshot: null, tail: []);
        Assert.Equal(0, state.FilledCount);
        Assert.Equal("demo", state.Id);
        Assert.Equal(Dims, state.Dimensions);
    }

    [Fact]
    public void Restores_from_a_snapshot_alone()
    {
        var cells = new List<CellOp> { new("b0", 0, "hello", new HlcTimestamp(1, 0, "n")) };
        var snapshot = new SheetSnapshot
        {
            SheetId = "demo",
            CellsJson = System.Text.Json.JsonSerializer.Serialize(cells),
            UpToOpId = 5,
            WrittenAtUtc = DateTimeOffset.UnixEpoch,
        };

        var state = SheetRestorer.Restore("demo", Dims, snapshot, tail: []);

        Assert.Equal("hello", state.Get("b0", 0)?.Value);
        Assert.Equal(1, state.FilledCount);
    }

    [Fact]
    public void Replays_the_tail_after_the_snapshot()
    {
        var cells = new List<CellOp> { new("b0", 0, "old", new HlcTimestamp(1, 0, "n")) };
        var snapshot = new SheetSnapshot
        {
            SheetId = "demo",
            CellsJson = System.Text.Json.JsonSerializer.Serialize(cells),
            UpToOpId = 5,
            WrittenAtUtc = DateTimeOffset.UnixEpoch,
        };
        var tail = new[] { Entry(6, 0, 0, "new", wallMs: 2), Entry(7, 1, 0, "second cell", wallMs: 3) };

        var state = SheetRestorer.Restore("demo", Dims, snapshot, tail);

        Assert.Equal("new", state.Get("b0", 0)?.Value); // the tail's write beat the snapshot's
        Assert.Equal("second cell", state.Get("b1", 0)?.Value);
        Assert.Equal(2, state.FilledCount);
    }

    [Fact]
    public void Works_with_only_a_tail_and_no_snapshot()
    {
        var tail = new[] { Entry(1, 0, 0, "a", wallMs: 1), Entry(2, 0, 1, "b", wallMs: 1) };
        var state = SheetRestorer.Restore("demo", Dims, snapshot: null, tail);
        Assert.Equal(2, state.FilledCount);
    }

    [Fact]
    public void A_tail_entry_older_than_the_snapshot_for_the_same_cell_does_not_win()
    {
        // This can genuinely happen: the tail is "logged after the snapshot", not "happened after
        // the snapshot's values" -- a slightly-behind clock can log an op with an older HLC
        // timestamp than something the snapshot already reflects. Replay must not undo it.
        var cells = new List<CellOp> { new("b0", 0, "newer, already in the snapshot", new HlcTimestamp(100, 0, "n")) };
        var snapshot = new SheetSnapshot
        {
            SheetId = "demo",
            CellsJson = System.Text.Json.JsonSerializer.Serialize(cells),
            UpToOpId = 5,
            WrittenAtUtc = DateTimeOffset.UnixEpoch,
        };
        var tail = new[] { Entry(6, 0, 0, "older, logged later", wallMs: 1) };

        var state = SheetRestorer.Restore("demo", Dims, snapshot, tail);

        Assert.Equal("newer, already in the snapshot", state.Get("b0", 0)?.Value);
    }

    [Fact]
    public void Replaying_the_same_op_twice_changes_nothing()
    {
        // The situation SnapshotService's doc comment describes: the snapshot already reflects an
        // op that the tail also contains (write-behind lag). Idempotent merge makes this safe.
        var cells = new List<CellOp> { new("b0", 0, "x", new HlcTimestamp(5, 0, "n")) };
        var snapshot = new SheetSnapshot
        {
            SheetId = "demo",
            CellsJson = System.Text.Json.JsonSerializer.Serialize(cells),
            UpToOpId = 5,
            WrittenAtUtc = DateTimeOffset.UnixEpoch,
        };
        var tail = new[] { Entry(6, 0, 0, "x", wallMs: 5) }; // same cell, same timestamp, same value

        var state = SheetRestorer.Restore("demo", Dims, snapshot, tail);

        Assert.Equal("x", state.Get("b0", 0)?.Value);
        Assert.Equal(1, state.FilledCount);
    }

    [Fact]
    public void A_cleared_cell_in_the_tail_stays_cleared()
    {
        var cells = new List<CellOp> { new("b0", 0, "will be cleared", new HlcTimestamp(1, 0, "n")) };
        var snapshot = new SheetSnapshot
        {
            SheetId = "demo",
            CellsJson = System.Text.Json.JsonSerializer.Serialize(cells),
            UpToOpId = 1,
            WrittenAtUtc = DateTimeOffset.UnixEpoch,
        };
        var tail = new[] { Entry(2, 0, 0, value: null, wallMs: 2) }; // a clear

        var state = SheetRestorer.Restore("demo", Dims, snapshot, tail);

        Assert.True(state.Get("b0", 0) is { Value: null }); // a tombstone, not "never written"
        Assert.Equal(0, state.FilledCount);
    }

    [Fact]
    public void ToSnapshot_round_trips_through_JSON_and_Restore()
    {
        var live = new SheetState("demo", Dims);
        live.Apply(new CellOp("b0", 0, "a", new HlcTimestamp(1, 0, "n")));
        live.Apply(new CellOp("b2", 3, "b", new HlcTimestamp(2, 0, "n")));

        var snapshot = SheetRestorer.ToSnapshot(live, upToOpId: 42, TimeProvider.System);
        Assert.Equal("demo", snapshot.SheetId);
        Assert.Equal(42, snapshot.UpToOpId);

        var restored = SheetRestorer.Restore("demo", Dims, snapshot, tail: []);
        Assert.Equal("a", restored.Get("b0", 0)?.Value);
        Assert.Equal("b", restored.Get("b2", 3)?.Value);
        Assert.Equal(2, restored.FilledCount);
    }

    private const string RowId = "0123456789abcdef0123456789abcdef";

    [Fact]
    public void A_snapshot_carries_inserted_rows_and_the_cells_in_them()
    {
        var live = new SheetState("demo", Dims);
        live.InsertRow(new RowOp(RowId, "0000k"));
        live.Apply(new CellOp(RowId, 1, "in the new row", new HlcTimestamp(1, 0, "n")));

        var snapshot = SheetRestorer.ToSnapshot(live, upToOpId: 1, TimeProvider.System);
        var restored = SheetRestorer.Restore("demo", Dims, snapshot, tail: []);

        Assert.True(restored.HasRow(RowId));
        Assert.Equal("0000k", restored.RowKey(RowId));
        Assert.Equal("in the new row", restored.Get(RowId, 1)?.Value);
    }

    [Fact]
    public void Row_inserts_in_the_tail_are_replayed()
    {
        var tail = new[]
        {
            new OpLogEntry { Id = 1, SheetId = "demo", RowId = RowId, RowKey = "0000k", NodeId = "" },
            new OpLogEntry { Id = 2, SheetId = "demo", RowId = RowId, Col = 0, Value = "hi", WallMs = 5, NodeId = "n" },
        };

        var state = SheetRestorer.Restore("demo", Dims, snapshot: null, tail);

        Assert.Equal("0000k", state.RowKey(RowId));
        Assert.Equal("hi", state.Get(RowId, 0)?.Value);
    }

    [Fact]
    public void A_row_insert_is_logged_as_a_row_and_not_as_a_cell_edit()
    {
        var entry = SheetRestorer.ToLogEntry("demo", new RowOp(RowId, "0000k"));

        Assert.Equal("0000k", entry.RowKey);
        Assert.Equal(RowId, entry.RowId);
        Assert.Null(SheetRestorer.ToLogEntry("demo", new CellOp("b0", 0, "x", new HlcTimestamp(1, 0, "n"))).RowKey);
    }

    [Fact]
    public async Task RestoreAsync_reads_the_snapshot_and_only_the_tail_after_it()
    {
        var store = new InMemoryPersistenceStore();
        await store.AppendAsync([Entry(0, 0, 0, "will be in the snapshot", wallMs: 1)]);
        // Take a snapshot as of the entry actually written (InMemoryPersistenceStore assigns Ids
        // starting at 1, so re-fetch to know the real one).
        var latest = await store.GetLatestOpIdAsync("demo");
        var state = new SheetState("demo", Dims);
        state.Apply(new CellOp("b0", 0, "will be in the snapshot", new HlcTimestamp(1, 0, "n")));
        await store.SaveSnapshotAsync(SheetRestorer.ToSnapshot(state, latest, TimeProvider.System));

        await store.AppendAsync([Entry(0, 1, 0, "after the snapshot", wallMs: 2)]);

        var restored = await SheetRestorer.RestoreAsync(store, "demo", Dims);

        Assert.Equal("will be in the snapshot", restored.Get("b0", 0)?.Value);
        Assert.Equal("after the snapshot", restored.Get("b1", 0)?.Value);
    }
}
