namespace GridSync.Api.Persistence;

/// <summary>
/// One accepted edit, as stored in the append-only log. Either a cell edit, a mirror of
/// <see cref="Core.CellOp"/>, or a row insert, told apart by <see cref="RowKey"/>: it is null for a
/// cell edit and holds the new row's sort key for an insert (then <see cref="Col"/>, the value and
/// the timestamp columns are unused, and <see cref="NodeId"/> is empty). <see cref="Id"/> is
/// assigned by the database (an ever-increasing identity column), and that assignment order is what
/// "the log" means: replaying entries in <see cref="Id"/> order reproduces the sheet exactly, because
/// <see cref="Id"/> order is also apply order, and the merges in <see cref="Core.SheetState"/> don't
/// care what order they are fed in anyway (they are commutative), so replay is safe however the
/// entries arrive.
/// </summary>
public sealed class OpLogEntry
{
    public long Id { get; set; }
    public required string SheetId { get; set; }
    public required string RowId { get; set; }
    public int Col { get; set; }
    public string? Value { get; set; }
    public long WallMs { get; set; }
    public int Counter { get; set; }
    public required string NodeId { get; set; }

    /// <summary>Null for a cell edit; the sort key of the inserted row for a row insert.</summary>
    public string? RowKey { get; set; }
}
