using GridSync.Core.Formulas;

namespace GridSync.Core.Tests.Formulas;

public class FormulaParserTests
{
    private static string Tree(string formula) => AstDump.Of(FormulaParser.Parse(formula));

    [Theory]
    [InlineData("=42", "42")]
    [InlineData("=\"hi\"", "\"hi\"")]
    [InlineData("=A1", "A1")]
    [InlineData("=(A1)", "A1")]
    [InlineData("=TAX", "name:TAX")]
    [InlineData("=tax", "name:TAX")]
    public void Parses_atoms(string formula, string expected) =>
        Assert.Equal(expected, Tree(formula));

    [Theory]
    [InlineData("=1+2*3", "(1 + (2 * 3))")]
    [InlineData("=1*2+3", "((1 * 2) + 3)")]
    [InlineData("=(1+2)*3", "((1 + 2) * 3)")]
    [InlineData("=1+2+3", "((1 + 2) + 3)")]
    [InlineData("=1-2-3", "((1 - 2) - 3)")]
    [InlineData("=8/4/2", "((8 / 4) / 2)")]
    [InlineData("=2*3^2", "(2 * (3 ^ 2))")]
    public void Applies_arithmetic_precedence_and_left_associativity(string formula, string expected) =>
        Assert.Equal(expected, Tree(formula));

    [Theory]
    [InlineData("=-2^2", "((-2) ^ 2)")]      // Excel: unary minus binds tighter than ^, so this is 4
    [InlineData("=2^-1", "(2 ^ (-1))")]
    [InlineData("=2^3^2", "((2 ^ 3) ^ 2)")]  // Excel: ^ is left-associative, so this is 64
    [InlineData("=--5", "(-(-5))")]
    [InlineData("=1--1", "(1 - (-1))")]
    [InlineData("=-A1*2", "((-A1) * 2)")]
    [InlineData("=-(1+2)", "(-(1 + 2))")]
    public void Follows_Excels_unary_minus_and_exponent_rules(string formula, string expected) =>
        Assert.Equal(expected, Tree(formula));

    [Theory]
    [InlineData("=\"a\"&\"b\"", "(\"a\" & \"b\")")]
    [InlineData("=1&2+3", "(1 & (2 + 3))")]     // + binds tighter than &
    [InlineData("=1+2=3", "((1 + 2) = 3)")]      // comparisons are the loosest
    [InlineData("=1&2=12", "((1 & 2) = 12)")]
    [InlineData("=A1<>B1", "(A1 <> B1)")]
    [InlineData("=A1<=B1", "(A1 <= B1)")]
    [InlineData("=1<2<3", "((1 < 2) < 3)")]
    public void Ranks_concatenation_above_comparison_and_below_addition(string formula, string expected) =>
        Assert.Equal(expected, Tree(formula));

    [Theory]
    [InlineData("=A1:B2", "A1:B2")]
    [InlineData("=B2:A1", "A1:B2")]   // normalized so the evaluator never has to care
    [InlineData("=B1:A2", "A1:B2")]
    [InlineData("=A1:A1", "A1:A1")]
    [InlineData("=a1:c3", "A1:C3")]
    public void Parses_and_normalizes_ranges(string formula, string expected) =>
        Assert.Equal(expected, Tree(formula));

    [Theory]
    [InlineData("=SUM(A1:A3)", "SUM(A1:A3)")]
    [InlineData("=sum(a1:a3)", "SUM(A1:A3)")]
    [InlineData("=SUM(1,2,3)", "SUM(1, 2, 3)")]
    [InlineData("=NOW()", "NOW()")]
    [InlineData("=IF(A1>0,\"pos\",\"neg\")", "IF((A1 > 0), \"pos\", \"neg\")")]
    [InlineData("=ROUND(SUM(A1:A3)/3,2)", "ROUND((SUM(A1:A3) / 3), 2)")]
    [InlineData("=1+SUM(2,3)*4", "(1 + (SUM(2, 3) * 4))")]
    [InlineData("=NOSUCHFN(1)", "NOSUCHFN(1)")] // unknown functions parse; the evaluator gives #NAME?
    public void Parses_function_calls(string formula, string expected) =>
        Assert.Equal(expected, Tree(formula));

    [Fact]
    public void Ignores_whitespace_between_tokens() =>
        Assert.Equal("(1 + (2 * A1))", Tree("= 1 +\t2 *  A1 "));

    [Theory]
    [InlineData("", 0)]              // no "="
    [InlineData("1+2", 0)]           // no "="
    [InlineData("=", 1)]             // nothing after it
    [InlineData("=1+", 3)]           // dangling operator
    [InlineData("=*2", 1)]           // operator with no left side
    [InlineData("=(1", 3)]           // unclosed paren: reported at the end of the text
    [InlineData("=1)", 2)]           // stray closing paren
    [InlineData("=1 2", 3)]          // two operands in a row
    [InlineData("=A1 B1", 4)]
    [InlineData("=SUM(1,)", 7)]      // trailing comma
    [InlineData("=SUM(,1)", 5)]      // leading comma
    [InlineData("=SUM(1 2)", 7)]     // missing comma
    [InlineData("=SUM(1", 6)]        // unclosed call
    [InlineData("=A1:5", 4)]         // a range needs a cell on both sides
    [InlineData("=A1:", 4)]
    [InlineData("=1:B2", 2)]         // ":" is only valid between two cells
    [InlineData("=A1:B2:C3", 6)]     // no chained ranges: the second ":" is the problem
    [InlineData("=\"open", 1)]       // tokenizer error surfaces too
    [InlineData("=1 $ 2", 3)]
    public void Rejects_malformed_formulas_and_says_where(string formula, int position)
    {
        var ex = Assert.Throws<FormulaSyntaxException>(() => FormulaParser.Parse(formula));
        Assert.Equal(position, ex.Position);
    }

    [Fact]
    public void Allows_nesting_up_to_the_limit()
    {
        var depth = FormulaParser.MaxDepth - 1; // the outermost expression uses one level itself
        var formula = "=" + new string('(', depth) + "1" + new string(')', depth);
        Assert.Equal("1", Tree(formula));
    }

    [Fact]
    public void Rejects_nesting_past_the_limit()
    {
        var depth = FormulaParser.MaxDepth;
        var formula = "=" + new string('(', depth) + "1" + new string(')', depth);
        Assert.Throws<FormulaSyntaxException>(() => FormulaParser.Parse(formula));
    }

    [Fact]
    public void Deeply_nested_input_fails_cleanly_instead_of_overflowing_the_stack()
    {
        // The cell length limit is 10,000, so this is a reachable input. Without the depth guard
        // this recursion could overflow the stack, and .NET cannot catch that: it ends the process.
        var formula = "=" + new string('(', 4_999) + "1" + new string(')', 4_999);
        Assert.Throws<FormulaSyntaxException>(() => FormulaParser.Parse(formula));
    }

    [Fact]
    public void A_long_run_of_unary_minus_is_also_depth_limited()
    {
        var formula = "=" + new string('-', 5_000) + "1";
        Assert.Throws<FormulaSyntaxException>(() => FormulaParser.Parse(formula));
    }

    [Fact]
    public void Long_left_associative_chains_parse_without_deep_recursion()
    {
        // 1+1+1+... is handled by the loop in ParseExpression, not by recursion, so it is not
        // subject to MaxDepth. (The evaluator will need its own answer for very long chains.)
        var formula = "=" + string.Join('+', Enumerable.Repeat("1", 4_000));
        Assert.IsType<BinaryExpr>(FormulaParser.Parse(formula));
    }
}
