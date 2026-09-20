using GridSync.Core.Formulas;

namespace GridSync.Core.Tests.Formulas;

public class CellAddressTests
{
    [Theory]
    [InlineData(0, "A")]
    [InlineData(25, "Z")]
    [InlineData(26, "AA")]
    [InlineData(51, "AZ")]
    [InlineData(701, "ZZ")]
    [InlineData(702, "AAA")]
    public void Names_columns_in_bijective_base_26(int col, string expected) =>
        Assert.Equal(expected, CellAddress.ColumnName(col));

    [Fact]
    public void Formats_zero_based_positions_as_A1() =>
        Assert.Equal("B12", CellAddress.ToA1(row: 11, col: 1));

    [Theory]
    [InlineData("A1", 0, 0)]
    [InlineData("b2", 1, 1)]
    [InlineData("Z100", 99, 25)]
    [InlineData("AA1", 0, 26)]
    [InlineData("XFD1048576", 1_048_575, 16_383)]
    public void Parses_valid_addresses_case_insensitively(string text, int row, int col)
    {
        Assert.True(CellAddress.TryParse(text, out var r, out var c));
        Assert.Equal((row, col), (r, c));
    }

    [Theory]
    [InlineData("")]
    [InlineData("A")]
    [InlineData("1")]
    [InlineData("A0")]
    [InlineData("A01")]
    [InlineData("1A")]
    [InlineData("A1B")]
    [InlineData("ABCD1")]
    [InlineData("A1000000000")] // ten digits
    [InlineData("A-1")]
    [InlineData("É1")]
    public void Rejects_everything_else(string text) =>
        Assert.False(CellAddress.TryParse(text, out _, out _));

    [Fact]
    public void Round_trips_through_ToA1()
    {
        foreach (var (row, col) in new[] { (0, 0), (9, 25), (99_999, 26), (5, 701) })
        {
            Assert.True(CellAddress.TryParse(CellAddress.ToA1(row, col), out var r, out var c));
            Assert.Equal((row, col), (r, c));
        }
    }
}
