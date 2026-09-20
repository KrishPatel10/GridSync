namespace GridSync.Core;

public sealed class SyncLimits
{
    /// <summary>Longest text a single cell may hold.</summary>
    public int MaxValueLength { get; init; } = 10_000;

    /// <summary>Most ops accepted in one ApplyOps call.</summary>
    public int MaxOpsPerBatch { get; init; } = 500;

    /// <summary>
    /// How far ahead of the server's clock an op's timestamp may be. Without this, a client with
    /// its clock set to 2099 would win every conflict forever.
    /// </summary>
    public TimeSpan MaxClockSkew { get; init; } = TimeSpan.FromSeconds(60);

    public int MaxNodeIdLength { get; init; } = 64;
}

public enum OpRejection
{
    None,
    OutOfBounds,
    ValueTooLong,
    MissingNodeId,
    TimestampTooFarInFuture,
    InvalidTimestamp,
}

public sealed class OpValidator(SyncLimits limits, TimeProvider time)
{
    public SyncLimits Limits { get; } = limits;

    public OpRejection Validate(CellOp op, SheetDimensions dims)
    {
        if (op.Row < 0 || op.Row >= dims.Rows || op.Col < 0 || op.Col >= dims.Cols)
            return OpRejection.OutOfBounds;

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
}
