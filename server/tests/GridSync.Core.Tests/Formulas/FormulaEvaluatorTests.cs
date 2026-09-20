using GridSync.Core.Formulas;

namespace GridSync.Core.Tests.Formulas;

/// <summary>
/// Things a shared JSON vector cannot express: how much work the evaluator does, how deep it
/// recurses, and which cells it touches. The values themselves are covered by the vectors.
/// </summary>
public class FormulaEvaluatorTests
{
    private static FormulaValue Eval(string formula, TestCells? cells = null) =>
        FormulaEvaluator.Evaluate(formula, cells ?? new TestCells());

    [Fact]
    public void A_very_long_chain_of_additions_does_not_recurse_per_term()
    {
        // 4,000 terms is 8,000 characters, inside the 10,000 character cell limit. The parser
        // builds a tree 4,000 levels deep on the left; the evaluator must walk it with a loop.
        var formula = "=" + string.Join('+', Enumerable.Repeat("1", 4_000));
        Assert.Equal(FormulaValue.FromNumber(4_000), Eval(formula));
    }

    [Fact]
    public void A_long_chain_of_mixed_operators_keeps_the_right_order()
    {
        // 1-1+1-1+... : strictly left to right, so the total alternates 0, 1, 0, 1...
        var terms = Enumerable.Range(0, 3_001).Select(i => (i % 2 == 0 ? "+" : "-") + "1");
        Assert.Equal(FormulaValue.FromNumber(1), Eval("=0" + string.Concat(terms)));
    }

    [Fact]
    public void A_long_chain_stops_at_the_first_error_and_reads_no_further_cells()
    {
        var cells = new TestCells();
        var formula = "=1/0" + string.Concat(Enumerable.Repeat("+A1", 2_000));

        Assert.Equal(FormulaValue.FromError(FormulaError.DivideByZero), Eval(formula, cells));
        Assert.Equal(0, cells.Reads);
    }

    [Fact]
    public void If_reads_only_the_cells_of_the_branch_it_takes()
    {
        var cells = new TestCells().Raw("A1", "1").Raw("B1", "2");
        Assert.Equal(FormulaValue.FromNumber(1), Eval("=IF(TRUE,A1,B1)", cells));
        Assert.Equal(1, cells.Reads);
    }

    [Fact]
    public void An_unknown_function_reads_no_cells()
    {
        var cells = new TestCells().Raw("A1", "1");
        Assert.Equal(FormulaValue.FromError(FormulaError.Name), Eval("=FOO(A1)", cells));
        Assert.Equal(0, cells.Reads);
    }

    [Fact]
    public void The_first_error_in_a_range_wins_in_row_major_order()
    {
        // B1 is before A2 when reading row by row, so its error is the one reported.
        var cells = new TestCells()
            .Value("A2", FormulaValue.FromError(FormulaError.Name))
            .Value("B1", FormulaValue.FromError(FormulaError.DivideByZero));

        Assert.Equal(FormulaValue.FromError(FormulaError.DivideByZero), Eval("=SUM(A1:B2)", cells));
    }

    [Fact]
    public void Nested_functions_at_the_parser_depth_limit_still_evaluate()
    {
        // Each SUM( nests one parse level, and the outermost expression takes one itself.
        var depth = FormulaParser.MaxDepth - 1;
        var formula = "=" + string.Concat(Enumerable.Repeat("SUM(", depth)) + "1" + new string(')', depth);
        Assert.Equal(FormulaValue.FromNumber(1), Eval(formula));
    }

    [Fact]
    public void Evaluating_an_already_parsed_tree_gives_the_same_answer()
    {
        var cells = new TestCells().Raw("A1", "4");
        var ast = FormulaParser.Parse("=A1*A1+1");

        Assert.Equal(FormulaEvaluator.Evaluate("=A1*A1+1", cells), FormulaEvaluator.Evaluate(ast, cells));
        Assert.Equal(FormulaValue.FromNumber(17), FormulaEvaluator.Evaluate(ast, cells));
    }

    [Fact]
    public void A_sheet_smaller_than_the_default_bounds_references()
    {
        var small = new TestCells(new SheetDimensions(10, 3));

        Assert.Equal(FormulaValue.FromError(FormulaError.Ref), FormulaEvaluator.Evaluate("=D1", small));
        Assert.Equal(FormulaValue.FromError(FormulaError.Ref), FormulaEvaluator.Evaluate("=A11", small));
        Assert.Equal(FormulaValue.FromNumber(0), FormulaEvaluator.Evaluate("=C10", small));
    }
}
