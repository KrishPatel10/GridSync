namespace GridSync.Api.Persistence;

/// <summary>
/// One accepted edit, as stored in the append-only log. A direct mirror of <see cref="Core.CellOp"/>
/// plus the sheet it belongs to and the identity EF Core needs. <see cref="Id"/> is assigned by the
/// database (an ever-increasing identity column), and that assignment order is what "the log" means:
/// replaying entries in <see cref="Id"/> order reproduces the sheet exactly, because <see cref="Id"/>
/// order is also apply order, and the LWW merge in <see cref="Core.SheetState"/> doesn't care what
/// order it's fed in anyway (it's commutative), so replay is safe however the entries arrive.
/// </summary>
public sealed class OpLogEntry
{
    public long Id { get; set; }
    public required string SheetId { get; set; }
    public int Row { get; set; }
    public int Col { get; set; }
    public string? Value { get; set; }
    public long WallMs { get; set; }
    public int Counter { get; set; }
    public required string NodeId { get; set; }
}
