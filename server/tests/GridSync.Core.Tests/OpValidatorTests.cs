namespace GridSync.Core.Tests;

public class OpValidatorTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 20, 12, 0, 0, TimeSpan.Zero);
    private static readonly SheetDimensions Dims = new(100, 26);

    private readonly OpValidator _validator = new(
        new SyncLimits { MaxValueLength = 10, MaxClockSkew = TimeSpan.FromSeconds(60) },
        new ManualTimeProvider(Now));

    private static CellOp Op(int row = 0, int col = 0, string? value = "ok", long? wall = null, string node = "n") =>
        new(row, col, value, new HlcTimestamp(wall ?? Now.ToUnixTimeMilliseconds(), 0, node));

    [Fact]
    public void Accepts_a_well_formed_op() =>
        Assert.Equal(OpRejection.None, _validator.Validate(Op(), Dims));

    [Fact]
    public void Accepts_a_clear() =>
        Assert.Equal(OpRejection.None, _validator.Validate(Op(value: null), Dims));

    [Fact]
    public void Rejects_cells_outside_the_sheet()
    {
        Assert.Equal(OpRejection.OutOfBounds, _validator.Validate(Op(row: 100), Dims));
        Assert.Equal(OpRejection.OutOfBounds, _validator.Validate(Op(col: 26), Dims));
        Assert.Equal(OpRejection.OutOfBounds, _validator.Validate(Op(row: -1), Dims));
    }

    [Fact]
    public void Rejects_values_over_the_length_limit() =>
        Assert.Equal(OpRejection.ValueTooLong, _validator.Validate(Op(value: "12345678901"), Dims));

    [Fact]
    public void Rejects_ops_without_a_node_id() =>
        Assert.Equal(OpRejection.MissingNodeId, _validator.Validate(Op(node: ""), Dims));

    [Fact]
    public void Allows_small_clock_skew_but_rejects_timestamps_far_in_the_future()
    {
        var slightlyAhead = Now.AddSeconds(30).ToUnixTimeMilliseconds();
        var wayAhead = Now.AddMinutes(10).ToUnixTimeMilliseconds();

        Assert.Equal(OpRejection.None, _validator.Validate(Op(wall: slightlyAhead), Dims));
        Assert.Equal(OpRejection.TimestampTooFarInFuture, _validator.Validate(Op(wall: wayAhead), Dims));
    }
}
