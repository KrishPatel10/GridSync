using GridSync.Api.Sheets;
using GridSync.Core;
using Microsoft.Extensions.Options;

namespace GridSync.Api.Persistence;

/// <summary>
/// Periodically snapshots sheets that have accumulated enough new ops since their last one, so a
/// restore never has to replay the whole log from the start (see SheetRestorer). Checks every
/// sheet currently loaded in memory on a timer; "every N ops" is measured against the log, not a
/// wall-clock schedule, by comparing the log's latest Id to the snapshot's own bookmark.
///
/// Snapshotting from the live in-memory SheetState can run slightly ahead of what has actually
/// reached the log yet (write-behind lag): the snapshot may already reflect an op or two the
/// background writer hasn't flushed. That is harmless. Restoring replays the snapshot's cells and
/// then the log tail through the same idempotent, commutative merge live edits use, so replaying
/// something the snapshot already contains is a no-op, not a bug.
/// </summary>
public sealed class SnapshotService(
    SheetStore sheets,
    IPersistenceStore store,
    IOptions<GridSyncOptions> options,
    TimeProvider time,
    ILogger<SnapshotService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(options.Value.SnapshotCheckIntervalSeconds));
        while (await timer.WaitForNextTickAsync(stoppingToken)) await CheckAllAsync(stoppingToken);
    }

    /// <summary>
    /// One pass over every currently loaded sheet. Split out from ExecuteAsync so tests can drive
    /// it directly instead of waiting on a real timer.
    /// </summary>
    internal async Task CheckAllAsync(CancellationToken ct)
    {
        foreach (var sheet in sheets.All)
        {
            try
            {
                await MaybeSnapshotAsync(sheet, options.Value.SnapshotEveryNOps, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Log.SnapshotFailed(logger, sheet.Id, ex);
            }
        }
    }

    private async Task MaybeSnapshotAsync(SheetState sheet, int everyNOps, CancellationToken ct)
    {
        var existing = await store.GetSnapshotAsync(sheet.Id, ct);
        // Ids are one global sequence shared by every sheet's log entries, so "latest id minus the
        // snapshot's id" is not "how many ops this sheet got" unless nothing else was ever logged
        // in between. The tail (already scoped to this sheet) is what actually answers that.
        var tail = await store.GetTailAsync(sheet.Id, existing?.UpToOpId ?? 0, ct);
        if (tail.Count < everyNOps) return;

        var latestOpId = tail[^1].Id; // GetTailAsync returns entries oldest first
        await store.SaveSnapshotAsync(SheetRestorer.ToSnapshot(sheet, latestOpId, time), ct);
        Log.Snapshotted(logger, sheet.Id, latestOpId);
    }
}

internal static partial class Log
{
    [LoggerMessage(Level = LogLevel.Debug, Message = "Snapshotted sheet {SheetId} up to op {UpToOpId}")]
    public static partial void Snapshotted(ILogger logger, string sheetId, long upToOpId);

    [LoggerMessage(Level = LogLevel.Error, Message = "Failed to snapshot sheet {SheetId}")]
    public static partial void SnapshotFailed(ILogger logger, string sheetId, Exception ex);
}
