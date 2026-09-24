using GridSync.Api.Persistence;
using GridSync.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace GridSync.Api.Tests.Persistence;

public class OpLogPersistenceServiceTests
{
    private static CellOp Op(int row, int col, string value = "x") =>
        new(RowIds.ForBaseRow(row), col, value, new HlcTimestamp(1, 0, "n"));

    private static (OpLogChannel Channel, InMemoryPersistenceStore Store, OpLogPersistenceService Service) NewService()
    {
        var channel = new OpLogChannel();
        var store = new InMemoryPersistenceStore();
        var service = new OpLogPersistenceService(channel, store, NullLogger<OpLogPersistenceService>.Instance);
        return (channel, store, service);
    }

    [Fact]
    public async Task Writes_one_enqueued_op()
    {
        var (channel, store, service) = NewService();
        channel.Enqueue("demo", Op(0, 0));

        await service.DrainOnceAsync(CancellationToken.None);

        var tail = await store.GetTailAsync("demo", afterOpId: 0);
        Assert.Single(tail);
        Assert.Equal("x", tail[0].Value);
    }

    [Fact]
    public async Task A_burst_enqueued_before_draining_is_written_as_one_batch()
    {
        var (channel, store, service) = NewService();
        for (var i = 0; i < 50; i++) channel.Enqueue("demo", Op(0, i));

        await service.DrainOnceAsync(CancellationToken.None); // one pass, whatever is already queued

        var tail = await store.GetTailAsync("demo", afterOpId: 0);
        Assert.Equal(50, tail.Count);
    }

    [Fact]
    public async Task A_burst_bigger_than_the_batch_cap_is_written_over_more_than_one_pass()
    {
        var (channel, store, service) = NewService();
        var count = OpLogPersistenceService.MaxBatchSize + 10;
        for (var i = 0; i < count; i++) channel.Enqueue("demo", Op(0, i % 26));

        await service.DrainOnceAsync(CancellationToken.None);
        Assert.Equal(OpLogPersistenceService.MaxBatchSize, (await store.GetTailAsync("demo", 0)).Count);

        await service.DrainOnceAsync(CancellationToken.None);
        Assert.Equal(count, (await store.GetTailAsync("demo", 0)).Count);
    }

    [Fact]
    public async Task Ops_for_different_sheets_all_land_in_the_log_correctly()
    {
        var (channel, store, service) = NewService();
        channel.Enqueue("sheet-1", Op(0, 0));
        channel.Enqueue("sheet-2", Op(0, 0));

        await service.DrainOnceAsync(CancellationToken.None);

        Assert.Single(await store.GetTailAsync("sheet-1", 0));
        Assert.Single(await store.GetTailAsync("sheet-2", 0));
    }

    [Fact]
    public async Task Draining_with_nothing_queued_waits_rather_than_writing_an_empty_batch()
    {
        var (channel, _, service) = NewService();
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.DrainOnceAsync(cts.Token));
    }

    [Fact]
    public async Task A_write_failure_does_not_lose_ops_still_in_the_channel_or_crash_the_service()
    {
        var channel = new OpLogChannel();
        var store = new FailOnceStore();
        var service = new OpLogPersistenceService(channel, store, NullLogger<OpLogPersistenceService>.Instance);

        channel.Enqueue("demo", Op(0, 0));
        await service.DrainOnceAsync(CancellationToken.None); // the store throws; must not propagate
        Assert.Empty(await store.GetTailAsync("demo", 0)); // and indeed nothing was written

        channel.Enqueue("demo", Op(0, 1));
        await service.DrainOnceAsync(CancellationToken.None); // second call: the store behaves normally now
        Assert.Single(await store.GetTailAsync("demo", 0));
    }

    /// <summary>Wraps a real in-memory store but throws on the first AppendAsync, then delegates normally.</summary>
    private sealed class FailOnceStore : IPersistenceStore
    {
        private readonly InMemoryPersistenceStore _inner = new();
        private bool _thrown;

        public Task AppendAsync(IReadOnlyList<OpLogEntry> batch, CancellationToken ct = default)
        {
            if (!_thrown)
            {
                _thrown = true;
                throw new InvalidOperationException("simulated database failure");
            }
            return _inner.AppendAsync(batch, ct);
        }

        public Task<SheetSnapshot?> GetSnapshotAsync(string sheetId, CancellationToken ct = default) => _inner.GetSnapshotAsync(sheetId, ct);
        public Task<IReadOnlyList<OpLogEntry>> GetTailAsync(string sheetId, long afterOpId, CancellationToken ct = default) => _inner.GetTailAsync(sheetId, afterOpId, ct);
        public Task<long> GetLatestOpIdAsync(string sheetId, CancellationToken ct = default) => _inner.GetLatestOpIdAsync(sheetId, ct);
        public Task SaveSnapshotAsync(SheetSnapshot snapshot, CancellationToken ct = default) => _inner.SaveSnapshotAsync(snapshot, ct);
    }
}
