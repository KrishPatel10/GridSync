using FsCheck;
using FsCheck.Fluent;
using GridSync.Core.Rows;

namespace GridSync.Core.Tests;

public class SheetRowsTests
{
    private static readonly SheetDimensions Dims = new(100, 26);

    /// <summary>A stable, valid inserted-row id for a small number, so tests can name rows.</summary>
    private static string Id(int n) => n.ToString("x32");

    [Fact]
    public void A_new_sheet_has_only_its_initial_rows()
    {
        var sheet = new SheetState("s", Dims);

        Assert.True(sheet.HasRow("b0"));
        Assert.True(sheet.HasRow("b99"));
        Assert.False(sheet.HasRow("b100"));
        Assert.False(sheet.HasRow(Id(1)));
        Assert.Equal(0, sheet.InsertedRowCount);
    }

    [Fact]
    public void An_inserted_row_exists_with_its_key()
    {
        var sheet = new SheetState("s", Dims);

        Assert.True(sheet.InsertRow(new RowOp(Id(1), "V5")));

        Assert.True(sheet.HasRow(Id(1)));
        Assert.Equal("V5", sheet.RowKey(Id(1)));
        Assert.Equal(1, sheet.InsertedRowCount);
        Assert.Equal([new RowOp(Id(1), "V5")], sheet.RowSnapshot());
    }

    [Fact]
    public void Inserting_the_same_row_twice_is_a_no_op()
    {
        var sheet = new SheetState("s", Dims);

        Assert.True(sheet.InsertRow(new RowOp(Id(1), "V5")));
        Assert.False(sheet.InsertRow(new RowOp(Id(1), "V5"))); // a retry after a dropped connection

        Assert.Equal(1, sheet.InsertedRowCount);
    }

    [Fact]
    public void A_rows_key_never_changes_once_it_exists()
    {
        var sheet = new SheetState("s", Dims);
        sheet.InsertRow(new RowOp(Id(1), "V5"));

        Assert.False(sheet.InsertRow(new RowOp(Id(1), "Z")));

        Assert.Equal("V5", sheet.RowKey(Id(1)));
    }

    [Fact]
    public void Cells_in_an_inserted_row_are_kept_separately_from_the_row_that_used_to_have_their_number()
    {
        var sheet = new SheetState("s", Dims);
        sheet.InsertRow(new RowOp(Id(1), FractionalIndex.Between(FractionalIndex.ForBaseRow(0), FractionalIndex.ForBaseRow(1))));

        sheet.Apply(new CellOp("b1", 0, "the old second row", new HlcTimestamp(1, 0, "n")));
        sheet.Apply(new CellOp(Id(1), 0, "the new row", new HlcTimestamp(2, 0, "n")));

        // The point of stable ids: inserting above "b1" did not change what an edit to "b1" means.
        Assert.Equal("the old second row", sheet.Get("b1", 0)?.Value);
        Assert.Equal("the new row", sheet.Get(Id(1), 0)?.Value);
    }

    // ---- Convergence, over random histories ------------------------------------------------------

    private abstract record Step;
    private sealed record InsertStep(RowOp Row) : Step;
    private sealed record EditStep(CellOp Cell) : Step;

    /// <summary>
    /// A random history: a few writers inserting rows and editing cells (some in rows that others
    /// inserted, some on initial rows, some clears), plus exact duplicates as if retried. Each row
    /// id gets one key, as real ids are random and never reused with a different key.
    /// </summary>
    private static List<Step> History(int seed)
    {
        var rng = new Random(seed);
        var nodes = new[] { "alice", "bob", "carol" };
        var rowIds = Enumerable.Range(1, 12).Select(Id).ToArray();
        var keys = rowIds.ToDictionary(id => id, _ => FractionalIndex.Between(FractionalIndex.ForBaseRow(rng.Next(0, 5)), FractionalIndex.ForBaseRow(rng.Next(5, 9))));

        var steps = new List<Step>();
        for (var i = 0; i < 300; i++)
        {
            if (rng.Next(4) == 0)
            {
                var id = rowIds[rng.Next(rowIds.Length)];
                steps.Add(new InsertStep(new RowOp(id, keys[id])));
            }
            else
            {
                var row = rng.Next(3) == 0 ? "b" + rng.Next(0, 5) : rowIds[rng.Next(rowIds.Length)];
                var value = rng.Next(5) == 0 ? null : $"v{i}";
                // A real clock never stamps two different edits identically, so neither does this: the counter is unique.
                var ts = new HlcTimestamp(rng.Next(1, 100), i, nodes[rng.Next(3)]);
                steps.Add(new EditStep(new CellOp(row, rng.Next(3), value, ts)));
            }
        }

        steps.AddRange(steps.Take(60));
        return steps;
    }

    private static SheetState Replay(IEnumerable<Step> steps)
    {
        var sheet = new SheetState("s", Dims);
        foreach (var step in steps)
        {
            if (step is InsertStep insert) sheet.InsertRow(insert.Row);
            else if (step is EditStep edit) sheet.Apply(edit.Cell);
        }

        return sheet;
    }

    /// <summary>Everything a replica knows, in a canonical order, so two replicas can be compared as text.</summary>
    private static string Render(SheetState sheet) =>
        string.Join('\n',
            sheet.RowSnapshot().OrderBy(r => r.RowId, StringComparer.Ordinal).Select(r => $"row {r.RowId}={r.Key}")
                .Concat(sheet.Snapshot().OrderBy(c => c.RowId, StringComparer.Ordinal).ThenBy(c => c.Col)
                    .Select(c => $"cell {c.RowId},{c.Col}={c.Value ?? "<cleared>"}@{c.Ts}")));

    [Fact]
    public void Replicas_converge_whatever_order_rows_and_edits_arrive_in()
    {
        Prop.ForAll(Gen.Choose(0, 1_000_000).ToArbitrary(), seed =>
        {
            var history = History(seed);
            var expected = Render(Replay(history));

            var shuffler = new Random(seed + 1);
            for (var replica = 0; replica < 8; replica++)
            {
                if (Render(Replay(history.OrderBy(_ => shuffler.Next()))) != expected) return false;
            }

            return true;
        }).QuickCheckThrowOnFailure();
    }

    [Fact]
    public void A_replica_that_saw_only_part_of_the_history_catches_up_by_receiving_the_rest()
    {
        Prop.ForAll(Gen.Choose(0, 1_000_000).ToArbitrary(), seed =>
        {
            var history = History(seed);
            var cut = new Random(seed + 2).Next(history.Count);

            // Sees the first part, then everything again (as a snapshot plus later broadcasts would deliver).
            var partial = Replay(history.Take(cut));
            foreach (var step in history)
            {
                if (step is InsertStep insert) partial.InsertRow(insert.Row);
                else if (step is EditStep edit) partial.Apply(edit.Cell);
            }

            return Render(partial) == Render(Replay(history));
        }).QuickCheckThrowOnFailure();
    }

    [Fact]
    public void Concurrent_inserts_from_many_threads_lose_no_row()
    {
        var sheet = new SheetState("s", Dims);
        var rows = Enumerable.Range(1, 2_000).Select(i => new RowOp(Id(i), FractionalIndex.ForBaseRow(i))).ToArray();

        Parallel.ForEach(rows.Concat(rows.Take(500)).OrderBy(_ => Guid.NewGuid()), row => sheet.InsertRow(row));

        Assert.Equal(2_000, sheet.InsertedRowCount);
    }
}
