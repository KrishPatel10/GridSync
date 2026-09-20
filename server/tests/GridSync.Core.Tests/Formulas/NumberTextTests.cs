using GridSync.Core.Formulas;

namespace GridSync.Core.Tests.Formulas;

public class NumberTextTests
{
    [Theory]
    [InlineData("5", 5.0)]
    [InlineData("-5", -5.0)]
    [InlineData("+5", 5.0)]
    [InlineData("3.14", 3.14)]
    [InlineData(".5", 0.5)]
    [InlineData("5.", 5.0)]
    [InlineData("-.5", -0.5)]
    [InlineData("1e3", 1000.0)]
    [InlineData("1E+3", 1000.0)]
    [InlineData("2.5e-2", 0.025)]
    [InlineData("007", 7.0)]
    public void Parses_whole_string_numbers(string text, double expected)
    {
        Assert.True(NumberText.TryParse(text, out var value));
        Assert.Equal(expected, value);
    }

    [Theory]
    [InlineData("")]
    [InlineData(".")]
    [InlineData("-")]
    [InlineData("e5")]
    [InlineData("1e")]
    [InlineData("1e+")]
    [InlineData("1.2.3")]
    [InlineData(" 5")]
    [InlineData("5 ")]
    [InlineData("1,000")]
    [InlineData("5x")]
    [InlineData("--5")]
    [InlineData("Infinity")]
    [InlineData("NaN")]
    [InlineData("0x10")]
    [InlineData("1e400")]   // too big for a double
    [InlineData("１２")]     // full-width digits are not ASCII digits
    public void Rejects_everything_else(string text) =>
        Assert.False(NumberText.TryParse(text, out _));

    [Theory]
    [InlineData(0.0, "0")]
    [InlineData(1.0, "1")]
    [InlineData(-1.0, "-1")]
    [InlineData(100.0, "100")]
    [InlineData(123.456, "123.456")]
    [InlineData(0.5, "0.5")]
    [InlineData(-0.25, "-0.25")]
    [InlineData(0.1 + 0.2, "0.3")]
    [InlineData(1.0 / 3, "0.333333333333333")]
    [InlineData(2.0 / 3, "0.666666666666667")]
    [InlineData(123456789012345.0, "123456789012345")]
    [InlineData(1e14, "100000000000000")]
    [InlineData(1e15, "1E+15")]
    [InlineData(1.5e15, "1.5E+15")]
    [InlineData(-2.5e20, "-2.5E+20")]
    [InlineData(1e-5, "0.00001")]
    [InlineData(1.5e-5, "0.000015")]
    [InlineData(1e-6, "1E-06")]
    [InlineData(1.5e-7, "1.5E-07")]
    [InlineData(1e-100, "1E-100")]
    [InlineData(1e100, "1E+100")]
    [InlineData(double.MaxValue, "1.79769313486232E+308")]
    [InlineData(double.Epsilon, "4.94065645841247E-324")]
    public void Formats_numbers_with_fifteen_significant_digits(double value, string expected) =>
        Assert.Equal(expected, NumberText.ToText(value));

    [Theory]
    [InlineData(2.675, 2, 2.68)]
    [InlineData(2.5, 0, 3.0)]
    [InlineData(-2.5, 0, -3.0)]
    [InlineData(0.5, 0, 1.0)]
    [InlineData(0.49, 0, 0.0)]
    [InlineData(1234.5678, 2, 1234.57)]
    [InlineData(1234.5678, -3, 1000.0)]
    [InlineData(1500.0, -3, 2000.0)]
    [InlineData(9.995, 2, 10.0)]
    [InlineData(0.000001234, 8, 0.00000123)]
    [InlineData(12345.0, 10, 12345.0)]
    [InlineData(0.0, 3, 0.0)]
    public void Rounds_half_away_from_zero_on_the_decimal_digits(double value, int places, double expected) =>
        Assert.Equal(expected, DecimalRound.Round(value, places));

    [Theory]
    [InlineData(null, ValueKind.Empty)]
    [InlineData("", ValueKind.Empty)]
    [InlineData("42", ValueKind.Number)]
    [InlineData("4 2", ValueKind.Text)]
    [InlineData("=1+1", ValueKind.Text)] // formulas are the caller's business, not FromRaw's
    public void Reads_raw_cell_text(string? raw, ValueKind kind) =>
        Assert.Equal(kind, FormulaValue.FromRaw(raw).Kind);

    [Fact]
    public void Negative_zero_is_normalized_when_a_number_value_is_created() =>
        Assert.Equal("0", FormulaValue.FromNumber(-0.0).ToDisplayString());
}
