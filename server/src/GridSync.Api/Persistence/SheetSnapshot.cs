namespace GridSync.Api.Persistence;

/// <summary>
/// A sheet's full state as of some point in the log, so a restart doesn't have to replay every op
/// ever written. One row per sheet: a new snapshot replaces the old one, it doesn't add to a
/// history. <see cref="UpToOpId"/> is the highest <see cref="OpLogEntry.Id"/> this snapshot
/// reflects; restoring a sheet means loading this, then replaying only log entries after it.
/// </summary>
public sealed class SheetSnapshot
{
    public required string SheetId { get; set; }

    /// <summary>Every winning write, tombstones included, as JSON. Same shape as SheetState.Snapshot().</summary>
    public required string CellsJson { get; set; }

    /// <summary>Every inserted row, as JSON. The sheet's initial rows are implicit and are not listed.</summary>
    public string RowsJson { get; set; } = "[]";

    public long UpToOpId { get; set; }
    public DateTimeOffset WrittenAtUtc { get; set; }
}
