using GridSync.Core.Formulas;

namespace GridSync.Core.Tests.Formulas;

/// <summary>
/// What the shared scenarios cannot express: the public API surface, and the sizes where a naive
/// recursive implementation would overflow the stack (which, in .NET, ends the process).
/// </summary>
public class SheetCalculatorTests
{
    private static SheetCalculator New(int rows = 100_000, int cols = 26)
    {
        var calc = new SheetCalculator();
        calc.SetDimensions(rows, cols);
        return calc;
    }

    private static void Put(SheetCalculator calc, params (string Address, string? Raw)[] cells) =>
        calc.ApplyChanges(cells.Select(c =>
        {
            Assert.True(CellAddress.TryParse(c.Address, out var row, out var col), $"bad address {c.Address}");
            return new RawChange(row, col, c.Raw);
        }));

    private static string? Shown(SheetCalculator calc, string address)
    {
        Assert.True(CellAddress.TryParse(address, out var row, out var col));
        return calc.FormulaDisplayAt(row, col);
    }

    [Fact]
    public void Reports_which_cells_are_formulas_and_what_every_cell_is_worth()
    {
        var calc = New();
        Put(calc, ("A1", "hello"), ("A2", "42"), ("B1", "=A2*2"));

        Assert.False(calc.IsFormula(0, 0));
        Assert.Null(calc.FormulaDisplayAt(0, 0));
        Assert.True(calc.IsFormula(0, 1));
        Assert.Equal("84", Shown(calc, "B1"));

        Assert.Equal(FormulaValue.FromText("hello"), calc.GetValue(0, 0));
        Assert.Equal(FormulaValue.FromNumber(42), calc.GetValue(1, 0));
        Assert.Equal(FormulaValue.FromNumber(84), calc.GetValue(0, 1));
        Assert.Equal(FormulaValue.Empty, calc.GetValue(9, 9));
        Assert.Equal(1, calc.FormulaCount);
    }

    [Fact]
    public void Refuses_a_sheet_wider_than_the_key_packing_allows() =>
        Assert.Throws<ArgumentOutOfRangeException>(() => new SheetCalculator().SetDimensions(10, 16_385));

    [Fact]
    public void Keys_round_trip_through_row_and_column()
    {
        foreach (var (row, col) in new[] { (0, 0), (99_999, 25), (5, 16_383), (1_000_000, 3) })
        {
            var key = SheetCalculator.CellKey(row, col);
            Assert.Equal((row, col), (SheetCalculator.RowOf(key), SheetCalculator.ColOf(key)));
        }
    }

    [Fact]
    public void Follows_a_chain_of_100000_dependent_cells_without_overflowing_the_stack()
    {
        var calc = New();
        var changes = new List<RawChange> { new(0, 0, "1") };
        for (var row = 1; row < 100_000; row++) changes.Add(new RawChange(row, 0, $"=A{row}+1"));
        calc.ApplyChanges(changes);

        Assert.Equal("100000", calc.FormulaDisplayAt(99_999, 0));

        calc.ApplyChanges([new RawChange(0, 0, "11")]);
        Assert.Equal("100010", calc.FormulaDisplayAt(99_999, 0));
    }

    [Fact]
    public void Updates_10000_formulas_that_all_read_one_cell()
    {
        var calc = New();
        var changes = new List<RawChange> { new(0, 0, "1") };
        for (var row = 0; row < 10_000; row++) changes.Add(new RawChange(row, 1, "=A1*2"));
        calc.ApplyChanges(changes);

        var before = calc.EvaluationCount;
        var updates = calc.ApplyChanges([new RawChange(0, 0, "21")]);

        Assert.Equal(10_000, calc.EvaluationCount - before);
        Assert.Equal(10_000, updates.Count);
        Assert.Equal("42", calc.FormulaDisplayAt(0, 1));
        Assert.Equal("42", calc.FormulaDisplayAt(9_999, 1));
    }

    [Fact]
    public void Handles_a_100000_cell_cycle_without_overflowing_the_stack()
    {
        var calc = New();
        var changes = new List<RawChange>();
        for (var row = 0; row < 100_000; row++) changes.Add(new RawChange(row, 0, $"=A{(row + 1) % 100_000 + 1}"));
        calc.ApplyChanges(changes);

        Assert.Equal("#CYCLE!", calc.FormulaDisplayAt(0, 0));
        Assert.Equal("#CYCLE!", calc.FormulaDisplayAt(99_999, 0));
    }

    [Fact]
    public void Evaluates_a_formula_with_thousands_of_terms_inside_a_recalculation()
    {
        // The evaluator's own long-chain handling, reached through the calculator.
        var calc = New();
        Put(calc, ("A1", "1"), ("B1", "=" + string.Join('+', Enumerable.Repeat("A1", 4_000))));
        Assert.Equal("4000", Shown(calc, "B1"));

        Put(calc, ("A1", "2"));
        Assert.Equal("8000", Shown(calc, "B1"));
    }

    [Fact]
    public void Deeply_nested_formulas_that_fail_to_parse_show_an_error_and_do_not_break_the_sheet()
    {
        var calc = New();
        Put(calc, ("A1", "=" + new string('(', 5_000) + "1" + new string(')', 5_000)), ("B1", "=1+1"));
        Assert.Equal("#ERROR!", Shown(calc, "A1"));
        Assert.Equal("2", Shown(calc, "B1"));
    }
}
