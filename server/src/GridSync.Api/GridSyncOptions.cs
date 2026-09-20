using System.ComponentModel.DataAnnotations;
using GridSync.Core;

namespace GridSync.Api;

public sealed class GridSyncOptions
{
    public const string Section = "GridSync";

    [Range(1, 1_000_000)] public int Rows { get; init; } = 100_000;
    [Range(1, 16_384)] public int Cols { get; init; } = 26;

    /// <summary>Cap on in-memory sheets, so random sheet ids can't exhaust memory.</summary>
    [Range(1, 100_000)] public int MaxSheets { get; init; } = 1_000;

    [Range(1, 1_000_000)] public int MaxValueLength { get; init; } = 10_000;
    [Range(1, 10_000)] public int MaxOpsPerBatch { get; init; } = 500;
    [Range(1, 3_600)] public int MaxClockSkewSeconds { get; init; } = 60;

    public SheetDimensions Dimensions => new(Rows, Cols);

    public SyncLimits ToLimits() => new()
    {
        MaxValueLength = MaxValueLength,
        MaxOpsPerBatch = MaxOpsPerBatch,
        MaxClockSkew = TimeSpan.FromSeconds(MaxClockSkewSeconds),
    };
}
