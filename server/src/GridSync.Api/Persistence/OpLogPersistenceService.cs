namespace GridSync.Api.Persistence;

/// <summary>
/// Drains <see cref="OpLogChannel"/> and writes to <see cref="IPersistenceStore"/>. Runs for the
/// app's whole lifetime, one instance, one reader (the channel is built for that).
///
/// Batching falls out of the channel's own timing rather than a timer: each pass waits for at
/// least one entry, then immediately drains whatever else is already queued (up to
/// <see cref="MaxBatchSize"/>). A burst (a paste, a snapshot's worth of edits arriving together)
/// is written as one batch; a lone edit is written by itself. No artificial delay is added to
/// force bigger batches: that would only trade latency for a batching benefit that doesn't exist
/// when arrivals are already sparse.
/// </summary>
public sealed class OpLogPersistenceService(OpLogChannel channel, IPersistenceStore store, ILogger<OpLogPersistenceService> logger)
    : BackgroundService
{
    internal const int MaxBatchSize = 500;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (await DrainOnceAsync(stoppingToken)) { }
    }

    /// <summary>
    /// Waits for at least one queued entry, writes it and whatever else is already queued (up to
    /// MaxBatchSize) as one batch, and returns. Split out from ExecuteAsync so tests can drive one
    /// pass at a time instead of racing a real background loop. Returns false once the channel is
    /// completed (which production never does; tests use it to stop cleanly).
    /// </summary>
    internal async Task<bool> DrainOnceAsync(CancellationToken ct)
    {
        var reader = channel.Reader;
        if (!await reader.WaitToReadAsync(ct)) return false;

        var batch = new List<OpLogEntry>();
        while (batch.Count < MaxBatchSize && reader.TryRead(out var entry)) batch.Add(entry);
        if (batch.Count == 0) return true;

        try
        {
            await store.AppendAsync(batch, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // The database is unreachable or rejected the write. The sheet keeps working from
            // memory either way; these ops just won't be there if the server restarts before the
            // database recovers. See the durability trade-off note on OpLogChannel.
            Log.AppendFailed(logger, batch.Count, ex);
        }
        return true;
    }
}

internal static partial class Log
{
    [LoggerMessage(Level = LogLevel.Error, Message = "Failed to persist a batch of {Count} ops; they remain in memory only")]
    public static partial void AppendFailed(ILogger logger, int count, Exception ex);
}
