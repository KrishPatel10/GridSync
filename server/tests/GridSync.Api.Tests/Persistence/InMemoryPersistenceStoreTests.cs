using GridSync.Api.Persistence;

namespace GridSync.Api.Tests.Persistence;

/// <summary>
/// The fake's own contract tests. EfPersistenceStore is exercised through the SQLite-backed
/// integration tests instead (see PersistenceIntegrationTests): it is thin enough, and close
/// enough to EF Core's own well-tested plumbing, that mirroring these same cases against it would
/// mostly be re-testing EF Core, not this project's code.
/// </summary>
public class InMemoryPersistenceStoreTests
{
    private static OpLogEntry Entry(string sheetId, int row, int col, string? value = "x", long wallMs = 1, string node = "n") => new()
    {
        SheetId = sheetId,
        RowId = "b" + row,
        Col = col,
        Value = value,
        WallMs = wallMs,
        Counter = 0,
        NodeId = node,
    };

    [Fact]
    public async Task Assigns_increasing_ids_in_the_order_appended()
    {
        var store = new InMemoryPersistenceStore();
        var batch = new[] { Entry("demo", 0, 0), Entry("demo", 0, 1), Entry("demo", 0, 2) };

        await store.AppendAsync(batch);

        Assert.Equal([1, 2, 3], batch.Select(e => e.Id));
    }

    [Fact]
    public async Task Ids_keep_increasing_across_separate_append_calls()
    {
        var store = new InMemoryPersistenceStore();
        var first = new[] { Entry("demo", 0, 0) };
        var second = new[] { Entry("demo", 0, 1) };

        await store.AppendAsync(first);
        await store.AppendAsync(second);

        Assert.Equal(1, first[0].Id);
        Assert.Equal(2, second[0].Id);
    }

    [Fact]
    public async Task GetTail_returns_only_entries_after_the_given_id_oldest_first()
    {
        var store = new InMemoryPersistenceStore();
        await store.AppendAsync([Entry("demo", 0, 0), Entry("demo", 0, 1), Entry("demo", 0, 2)]);

        var tail = await store.GetTailAsync("demo", afterOpId: 1);

        Assert.Equal([2, 3], tail.Select(e => e.Id));
    }

    [Fact]
    public async Task GetTail_only_returns_entries_for_the_requested_sheet()
    {
        var store = new InMemoryPersistenceStore();
        await store.AppendAsync([Entry("sheet-1", 0, 0), Entry("sheet-2", 0, 0)]);

        var tail = await store.GetTailAsync("sheet-1", afterOpId: 0);

        Assert.Single(tail);
        Assert.Equal("sheet-1", tail[0].SheetId);
    }

    [Fact]
    public async Task GetLatestOpId_is_zero_for_a_sheet_never_written_to()
    {
        var store = new InMemoryPersistenceStore();
        Assert.Equal(0, await store.GetLatestOpIdAsync("nobody-has-ever-written-here"));
    }

    [Fact]
    public async Task GetLatestOpId_reports_the_highest_id_for_that_sheet_only()
    {
        var store = new InMemoryPersistenceStore();
        await store.AppendAsync([Entry("sheet-1", 0, 0), Entry("sheet-2", 0, 0), Entry("sheet-1", 0, 1)]);

        Assert.Equal(3, await store.GetLatestOpIdAsync("sheet-1"));
        Assert.Equal(2, await store.GetLatestOpIdAsync("sheet-2"));
    }

    [Fact]
    public async Task GetSnapshot_is_null_when_none_was_ever_saved()
    {
        var store = new InMemoryPersistenceStore();
        Assert.Null(await store.GetSnapshotAsync("demo"));
    }

    [Fact]
    public async Task SaveSnapshot_replaces_rather_than_accumulates()
    {
        var store = new InMemoryPersistenceStore();
        await store.SaveSnapshotAsync(new SheetSnapshot { SheetId = "demo", CellsJson = "[]", UpToOpId = 1, WrittenAtUtc = DateTimeOffset.UnixEpoch });
        await store.SaveSnapshotAsync(new SheetSnapshot { SheetId = "demo", CellsJson = "[\"newer\"]", UpToOpId = 9, WrittenAtUtc = DateTimeOffset.UnixEpoch });

        var snapshot = await store.GetSnapshotAsync("demo");

        Assert.Equal(9, snapshot?.UpToOpId);
        Assert.Equal("[\"newer\"]", snapshot?.CellsJson);
    }
}
