namespace GridSync.Core;

/// <summary>
/// "Set cell (Row, Col) to Value", stamped with the HLC time it was made.
/// A null Value means the cell was cleared. Clears are kept as tombstones rather than
/// deleted, otherwise an offline replica holding an older value would bring it back to life.
/// </summary>
/// <remarks>Serialized over SignalR as <c>{ row, col, value, ts }</c>, matching <c>CellOp</c> in the client.</remarks>
public sealed record CellOp(int Row, int Col, string? Value, HlcTimestamp Ts);

public readonly record struct CellKey(int Row, int Col);

/// <summary>The current winning write for one cell.</summary>
public sealed record CellEntry(string? Value, HlcTimestamp Ts);

public readonly record struct SheetDimensions(int Rows, int Cols);
