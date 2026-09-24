using GridSync.Api;
using GridSync.Api.Persistence;
using GridSync.Api.Sheets;
using GridSync.Core;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace GridSync.Api.Tests.Persistence;

public class SnapshotServiceTests
{
    private static readonly SheetDimensions Dims = new(100, 10);

    private static (SheetStore Sheets, InMemoryPersistenceStore Store, SnapshotService Service) NewService(int everyNOps = 5)
    {
        var store = new InMemoryPersistenceStore();
        var options = Microsoft.Extensions.Options.Options.Create(new GridSyncOptions { Rows = 100, Cols = 10, SnapshotEveryNOps = everyNOps });
        var sheets = new SheetStore(options, store);
        var service = new SnapshotService(sheets, store, options, TimeProvider.System, NullLogger<SnapshotService>.Instance);
        return (sheets, store, service);
    }

    private static async Task<SheetState> Opened(SheetStore sheets, string id) => await sheets.GetOrCreateAsync(id);

    private static CellOp Op(int row, int col, long wallMs) => new(RowIds.ForBaseRow(row), col, "x", new HlcTimestamp(wallMs, 0, "n"));

    [Fact]
    public async Task Does_not_snapshot_a_sheet_with_no_logged_ops()
    {
        var (sheets, store, service) = NewService();
        await Opened(sheets, "demo");

        await service.CheckAllAsync(CancellationToken.None);

        Assert.Null(await store.GetSnapshotAsync("demo"));
    }

    [Fact]
    public async Task Does_not_snapshot_before_the_threshold_is_reached()
    {
        var (sheets, store, service) = NewService(everyNOps: 5);
        var sheet = await Opened(sheets, "demo");
        for (var i = 0; i < 4; i++)
        {
            sheet.Apply(Op(0, i, i + 1));
            await store.AppendAsync([SheetRestorer.ToLogEntry("demo", Op(0, i, i + 1))]);
        }

        await service.CheckAllAsync(CancellationToken.None);

        Assert.Null(await store.GetSnapshotAsync("demo"));
    }

    [Fact]
    public async Task Snapshots_once_the_threshold_is_reached()
    {
        var (sheets, store, service) = NewService(everyNOps: 5);
        var sheet = await Opened(sheets, "demo");
        for (var i = 0; i < 5; i++)
        {
            sheet.Apply(Op(0, i, i + 1));
            await store.AppendAsync([SheetRestorer.ToLogEntry("demo", Op(0, i, i + 1))]);
        }

        await service.CheckAllAsync(CancellationToken.None);

        var snapshot = await store.GetSnapshotAsync("demo");
        Assert.NotNull(snapshot);
        Assert.Equal(5, snapshot!.UpToOpId);
    }

    [Fact]
    public async Task Needs_another_full_threshold_of_ops_before_snapshotting_again()
    {
        var (sheets, store, service) = NewService(everyNOps: 5);
        var sheet = await Opened(sheets, "demo");
        for (var i = 0; i < 5; i++)
        {
            sheet.Apply(Op(0, i, i + 1));
            await store.AppendAsync([SheetRestorer.ToLogEntry("demo", Op(0, i, i + 1))]);
        }
        await service.CheckAllAsync(CancellationToken.None);
        var first = await store.GetSnapshotAsync("demo");

        // Four more ops: still short of another full threshold.
        for (var i = 5; i < 9; i++)
        {
            sheet.Apply(Op(0, i, i + 1));
            await store.AppendAsync([SheetRestorer.ToLogEntry("demo", Op(0, i, i + 1))]);
        }
        await service.CheckAllAsync(CancellationToken.None);
        Assert.Equal(first!.UpToOpId, (await store.GetSnapshotAsync("demo"))!.UpToOpId); // unchanged

        // The fifth new op crosses the threshold.
        sheet.Apply(Op(0, 9, 10));
        await store.AppendAsync([SheetRestorer.ToLogEntry("demo", Op(0, 9, 10))]);
        await service.CheckAllAsync(CancellationToken.None);
        Assert.Equal(10, (await store.GetSnapshotAsync("demo"))!.UpToOpId);
    }

    [Fact]
    public async Task Checks_every_loaded_sheet_independently()
    {
        var (sheets, store, service) = NewService(everyNOps: 2);
        var busy = await Opened(sheets, "busy");
        var quiet = await Opened(sheets, "quiet");

        for (var i = 0; i < 3; i++)
        {
            busy.Apply(Op(0, i, i + 1));
            await store.AppendAsync([SheetRestorer.ToLogEntry("busy", Op(0, i, i + 1))]);
        }
        quiet.Apply(Op(0, 0, 1));
        await store.AppendAsync([SheetRestorer.ToLogEntry("quiet", Op(0, 0, 1))]);

        await service.CheckAllAsync(CancellationToken.None);

        Assert.NotNull(await store.GetSnapshotAsync("busy"));
        Assert.Null(await store.GetSnapshotAsync("quiet")); // only 1 op, threshold is 2
    }

    [Fact]
    public async Task A_snapshot_failure_for_one_sheet_does_not_stop_the_others()
    {
        var inner = new InMemoryPersistenceStore();
        var store = new ThrowsForSheetStore(inner, failingSheetId: "trouble");
        var options = Microsoft.Extensions.Options.Options.Create(new GridSyncOptions { Rows = 100, Cols = 10, SnapshotEveryNOps = 1 });
        var sheets = new SheetStore(options, store);
        var service = new SnapshotService(sheets, store, options, TimeProvider.System, NullLogger<SnapshotService>.Instance);

        var ok = await Opened(sheets, "ok");
        ok.Apply(Op(0, 0, 1));
        await store.AppendAsync([SheetRestorer.ToLogEntry("ok", Op(0, 0, 1))]);

        var trouble = await Opened(sheets, "trouble"); // succeeds: restoring an empty, never-persisted sheet reads nothing
        trouble.Apply(Op(0, 0, 1));
        await store.AppendAsync([SheetRestorer.ToLogEntry("trouble", Op(0, 0, 1))]);

        store.StartFailing();
        await service.CheckAllAsync(CancellationToken.None); // "trouble" throws; must not stop "ok"

        Assert.NotNull(await inner.GetSnapshotAsync("ok"));
        Assert.Null(await inner.GetSnapshotAsync("trouble"));
    }

    /// <summary>
    /// Wraps a real store but, once armed via StartFailing, throws from GetTailAsync for one
    /// chosen sheet. Starts un-armed so opening that sheet for the first time still succeeds.
    /// </summary>
    private sealed class ThrowsForSheetStore(IPersistenceStore inner, string failingSheetId) : IPersistenceStore
    {
        private bool _failing;

        public void StartFailing() => _failing = true;

        public Task AppendAsync(IReadOnlyList<OpLogEntry> batch, CancellationToken ct = default) => inner.AppendAsync(batch, ct);
        public Task<SheetSnapshot?> GetSnapshotAsync(string sheetId, CancellationToken ct = default) => inner.GetSnapshotAsync(sheetId, ct);
        public Task SaveSnapshotAsync(SheetSnapshot snapshot, CancellationToken ct = default) => inner.SaveSnapshotAsync(snapshot, ct);
        public Task<long> GetLatestOpIdAsync(string sheetId, CancellationToken ct = default) => inner.GetLatestOpIdAsync(sheetId, ct);

        public Task<IReadOnlyList<OpLogEntry>> GetTailAsync(string sheetId, long afterOpId, CancellationToken ct = default) =>
            _failing && sheetId == failingSheetId
                ? throw new InvalidOperationException("simulated failure for this sheet")
                : inner.GetTailAsync(sheetId, afterOpId, ct);
    }
}
