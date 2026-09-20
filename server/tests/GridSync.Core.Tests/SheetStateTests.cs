namespace GridSync.Core.Tests;

public class SheetStateTests
{
    private static readonly SheetDimensions Dims = new(100, 26);

    private static CellOp Op(int row, int col, string? value, long wall, int counter = 0, string node = "n") =>
        new(row, col, value, new HlcTimestamp(wall, counter, node));

    [Fact]
    public void Newer_write_wins()
    {
        var sheet = new SheetState("s", Dims);

        Assert.True(sheet.Apply(Op(0, 0, "old", wall: 1)));
        Assert.True(sheet.Apply(Op(0, 0, "new", wall: 2)));

        Assert.Equal("new", sheet.Get(0, 0)?.Value);
    }

    [Fact]
    public void Older_write_arriving_late_loses()
    {
        var sheet = new SheetState("s", Dims);

        sheet.Apply(Op(0, 0, "new", wall: 2));
        var applied = sheet.Apply(Op(0, 0, "old", wall: 1));

        Assert.False(applied);
        Assert.Equal("new", sheet.Get(0, 0)?.Value);
    }

    [Fact]
    public void Applying_the_same_op_twice_is_a_no_op()
    {
        var sheet = new SheetState("s", Dims);
        var op = Op(3, 4, "x", wall: 5);

        Assert.True(sheet.Apply(op));
        Assert.False(sheet.Apply(op)); // safe for clients to retry after a dropped connection
    }

    [Fact]
    public void Clearing_a_cell_keeps_a_tombstone_that_beats_older_values()
    {
        var sheet = new SheetState("s", Dims);

        sheet.Apply(Op(1, 1, "hello", wall: 1));
        sheet.Apply(Op(1, 1, null, wall: 3));        // cleared
        var resurrected = sheet.Apply(Op(1, 1, "hello again", wall: 2)); // late offline edit

        Assert.False(resurrected);
        Assert.Null(sheet.Get(1, 1)?.Value);
        Assert.Equal(0, sheet.FilledCount);
        Assert.Single(sheet.Snapshot()); // tombstone is still part of the snapshot
    }

    [Fact]
    public void Replicas_converge_no_matter_what_order_ops_arrive_in()
    {
        // A small, seeded property test: 3 writers, 30 cells, 2,000 ops (including clears and
        // exact duplicates), delivered to 25 replicas in 25 different random orders.
        var rng = new Random(20260920);
        var nodes = new[] { "alice", "bob", "carol" };
        var ops = new List<CellOp>();
        for (var i = 0; i < 2_000; i++)
        {
            var value = rng.Next(5) == 0 ? null : $"v{i}";
            ops.Add(Op(rng.Next(10), rng.Next(3), value, wall: rng.Next(1, 200), counter: rng.Next(3), node: nodes[rng.Next(3)]));
        }
        ops.AddRange(ops.Take(300)); // duplicates, as if retried after a reconnect

        string? expected = null;
        for (var replica = 0; replica < 25; replica++)
        {
            var sheet = new SheetState("s", Dims);
            foreach (var op in ops.OrderBy(_ => rng.Next())) sheet.Apply(op);

            var state = Render(sheet);
            expected ??= state;
            Assert.Equal(expected, state);
        }
    }

    [Fact]
    public void Concurrent_writers_on_one_cell_leave_the_greatest_timestamp_in_place()
    {
        var sheet = new SheetState("s", Dims);
        var ops = Enumerable.Range(1, 5_000).Select(i => Op(0, 0, $"v{i}", wall: i)).ToArray();

        Parallel.ForEach(ops.OrderBy(_ => Guid.NewGuid()), op => sheet.Apply(op));

        Assert.Equal("v5000", sheet.Get(0, 0)?.Value);
    }

    private static string Render(SheetState sheet) =>
        string.Join('\n', sheet.Snapshot()
            .OrderBy(o => o.Row).ThenBy(o => o.Col)
            .Select(o => $"{o.Row},{o.Col}={o.Value ?? "<cleared>"}@{o.Ts}"));
}
