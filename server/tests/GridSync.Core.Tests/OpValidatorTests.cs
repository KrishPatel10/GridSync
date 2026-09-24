using GridSync.Core.Rows;

namespace GridSync.Core.Tests;

public class OpValidatorTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 20, 12, 0, 0, TimeSpan.Zero);
    private static readonly SheetDimensions Dims = new(100, 26);
    private const string InsertedId = "0123456789abcdef0123456789abcdef";

    private readonly OpValidator _validator = new(
        new SyncLimits { MaxValueLength = 10, MaxClockSkew = TimeSpan.FromSeconds(60), MaxInsertedRows = 2 },
        new ManualTimeProvider(Now));

    private static SheetState Sheet() => new("s", Dims);

    private static CellOp Op(string row = "b0", int col = 0, string? value = "ok", long? wall = null, string node = "n") =>
        new(row, col, value, new HlcTimestamp(wall ?? Now.ToUnixTimeMilliseconds(), 0, node));

    [Fact]
    public void Accepts_a_well_formed_op() =>
        Assert.Equal(OpRejection.None, _validator.Validate(Op(), Sheet()));

    [Fact]
    public void Accepts_a_clear() =>
        Assert.Equal(OpRejection.None, _validator.Validate(Op(value: null), Sheet()));

    [Fact]
    public void Rejects_cells_outside_the_sheet()
    {
        Assert.Equal(OpRejection.OutOfBounds, _validator.Validate(Op(col: 26), Sheet()));
        Assert.Equal(OpRejection.OutOfBounds, _validator.Validate(Op(col: -1), Sheet()));
    }

    [Fact]
    public void Rejects_rows_that_do_not_exist()
    {
        Assert.Equal(OpRejection.UnknownRow, _validator.Validate(Op(row: "b100"), Sheet())); // one past the last initial row
        Assert.Equal(OpRejection.UnknownRow, _validator.Validate(Op(row: "b-1"), Sheet()));
        Assert.Equal(OpRejection.UnknownRow, _validator.Validate(Op(row: "b05"), Sheet())); // not the canonical spelling of b5
        Assert.Equal(OpRejection.UnknownRow, _validator.Validate(Op(row: "nonsense"), Sheet()));
        Assert.Equal(OpRejection.UnknownRow, _validator.Validate(Op(row: InsertedId), Sheet())); // never inserted
    }

    [Fact]
    public void Accepts_a_cell_in_a_row_that_was_inserted()
    {
        var sheet = Sheet();
        sheet.InsertRow(new RowOp(InsertedId, "V5"));
        Assert.Equal(OpRejection.None, _validator.Validate(Op(row: InsertedId), sheet));
    }

    [Fact]
    public void Rejects_values_over_the_length_limit() =>
        Assert.Equal(OpRejection.ValueTooLong, _validator.Validate(Op(value: "12345678901"), Sheet()));

    [Fact]
    public void Rejects_ops_without_a_node_id() =>
        Assert.Equal(OpRejection.MissingNodeId, _validator.Validate(Op(node: ""), Sheet()));

    [Fact]
    public void Allows_small_clock_skew_but_rejects_timestamps_far_in_the_future()
    {
        var slightlyAhead = Now.AddSeconds(30).ToUnixTimeMilliseconds();
        var wayAhead = Now.AddMinutes(10).ToUnixTimeMilliseconds();

        Assert.Equal(OpRejection.None, _validator.Validate(Op(wall: slightlyAhead), Sheet()));
        Assert.Equal(OpRejection.TimestampTooFarInFuture, _validator.Validate(Op(wall: wayAhead), Sheet()));
    }

    // ----- row inserts -----

    [Fact]
    public void Accepts_a_well_formed_row_insert() =>
        Assert.Equal(OpRejection.None, _validator.Validate(new RowOp(InsertedId, FractionalIndex.ForBaseRow(3)), Sheet()));

    [Theory]
    [InlineData("b5")]                                  // an initial row: cannot be "inserted"
    [InlineData("short")]
    [InlineData("0123456789ABCDEF0123456789ABCDEF")]    // uppercase: only lowercase hex is an id
    [InlineData("0123456789abcdef0123456789abcdeg")]    // not hex
    [InlineData("")]
    public void Rejects_row_ids_that_are_not_generated_ids(string id) =>
        Assert.Equal(OpRejection.InvalidRowId, _validator.Validate(new RowOp(id, "V"), Sheet()));

    [Theory]
    [InlineData("")]
    [InlineData("V0")]                                  // ends in 0: another spelling of "V"
    [InlineData("a-b")]
    [InlineData("VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV")] // longer than the limit
    public void Rejects_malformed_or_oversized_keys(string key) =>
        Assert.Equal(OpRejection.InvalidRowKey, _validator.Validate(new RowOp(InsertedId, key), Sheet()));

    [Fact]
    public void Rejects_new_rows_once_the_sheet_is_full_but_still_accepts_a_repeat_of_one_it_has()
    {
        var sheet = Sheet();
        sheet.InsertRow(new RowOp("a1234567890123456789012345678901", "V"));
        sheet.InsertRow(new RowOp("b1234567890123456789012345678901", "W"));

        Assert.Equal(OpRejection.TooManyRows, _validator.Validate(new RowOp(InsertedId, "X"), sheet));
        Assert.Equal(OpRejection.None, _validator.Validate(new RowOp("a1234567890123456789012345678901", "V"), sheet));
    }
}
