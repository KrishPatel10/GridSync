using GridSync.Core.Rows;

namespace GridSync.Core;

public sealed class SyncLimits
{
    /// <summary>Longest text a single cell may hold.</summary>
    public int MaxValueLength { get; init; } = 10_000;

    /// <summary>Most ops (row inserts and cell edits together) accepted in one ApplyOps call.</summary>
    public int MaxOpsPerBatch { get; init; } = 500;

    /// <summary>
    /// How far ahead of the server's clock an op's timestamp may be. Without this, a client with
    /// its clock set to 2099 would win every conflict forever.
    /// </summary>
    public TimeSpan MaxClockSkew { get; init; } = TimeSpan.FromSeconds(60);

    public int MaxNodeIdLength { get; init; } = 64;

    /// <summary>Most rows that may be inserted into one sheet, on top of the rows it starts with.</summary>
    public int MaxInsertedRows { get; init; } = 100_000;

    public int MaxRowKeyLength { get; init; } = 64;
}

public enum OpRejection
{
    None,
    OutOfBounds,
    UnknownRow,
    ValueTooLong,
    MissingNodeId,
    TimestampTooFarInFuture,
    InvalidTimestamp,
    InvalidRowId,
    InvalidRowKey,
    TooManyRows,
}

public sealed class OpValidator(SyncLimits limits, TimeProvider time)
{
    public SyncLimits Limits { get; } = limits;

    /// <summary>
    /// Checks an edit against the sheet as it is now. The row must already exist, which is why a
    /// batch applies its row inserts before its cell edits: a cell in a brand new row is valid in
    /// the same batch that creates the row.
    /// </summary>
    public OpRejection Validate(CellOp op, SheetState sheet)
    {
        if (op.RowId is null || op.Col < 0 || op.Col >= sheet.Dimensions.Cols)
            return OpRejection.OutOfBounds;

        if (!sheet.HasRow(op.RowId))
            return OpRejection.UnknownRow;

        if (op.Value is { Length: var len } && len > Limits.MaxValueLength)
            return OpRejection.ValueTooLong;

        if (string.IsNullOrEmpty(op.Ts.NodeId) || op.Ts.NodeId.Length > Limits.MaxNodeIdLength)
            return OpRejection.MissingNodeId;

        if (op.Ts.WallMs <= 0 || op.Ts.Counter < 0)
            return OpRejection.InvalidTimestamp;

        var latestAllowed = time.GetUtcNow().Add(Limits.MaxClockSkew).ToUnixTimeMilliseconds();
        if (op.Ts.WallMs > latestAllowed)
            return OpRejection.TimestampTooFarInFuture;

        return OpRejection.None;
    }

    /// <summary>
    /// Checks a row insert. Only inserted-row ids are accepted (a client cannot "insert" one of the
    /// implicit initial rows), the key must be well formed, and the sheet must have room.
    /// </summary>
    public OpRejection Validate(RowOp op, SheetState sheet)
    {
        if (op.RowId is null || !RowIds.IsInsertedId(op.RowId))
            return OpRejection.InvalidRowId;

        if (op.Key is null || op.Key.Length > Limits.MaxRowKeyLength || !FractionalIndex.IsValid(op.Key))
            return OpRejection.InvalidRowKey;

        // A repeat of a row we already have costs nothing, so it is never "too many".
        if (!sheet.HasRow(op.RowId) && sheet.InsertedRowCount >= Limits.MaxInsertedRows)
            return OpRejection.TooManyRows;

        return OpRejection.None;
    }
}
