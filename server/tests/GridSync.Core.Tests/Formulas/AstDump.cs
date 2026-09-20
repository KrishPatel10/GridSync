using System.Globalization;
using GridSync.Core.Formulas;

namespace GridSync.Core.Tests.Formulas;

/// <summary>
/// Prints an AST fully parenthesized so tests can assert on shape as a string:
/// "1+2*3" becomes "(1 + (2 * 3))". Only for short expressions: it recurses.
/// </summary>
internal static class AstDump
{
    public static string Of(Expr expr) => expr switch
    {
        NumberLiteral n => n.Value.ToString(CultureInfo.InvariantCulture),
        StringLiteral s => $"\"{s.Value}\"",
        CellRef c => CellAddress.ToA1(c.Row, c.Col),
        RangeRef r => $"{Of(r.TopLeft)}:{Of(r.BottomRight)}",
        NameRef n => $"name:{n.Name}",
        Negate n => $"(-{Of(n.Operand)})",
        BinaryExpr b => $"({Of(b.Left)} {Symbol(b.Op)} {Of(b.Right)})",
        FunctionCall f => $"{f.Name}({string.Join(", ", f.Args.Select(Of))})",
        _ => throw new NotSupportedException(expr.GetType().Name),
    };

    private static string Symbol(BinaryOp op) => op switch
    {
        BinaryOp.Add => "+",
        BinaryOp.Subtract => "-",
        BinaryOp.Multiply => "*",
        BinaryOp.Divide => "/",
        BinaryOp.Power => "^",
        BinaryOp.Concat => "&",
        BinaryOp.Equal => "=",
        BinaryOp.NotEqual => "<>",
        BinaryOp.Less => "<",
        BinaryOp.LessOrEqual => "<=",
        BinaryOp.Greater => ">",
        BinaryOp.GreaterOrEqual => ">=",
        _ => throw new NotSupportedException(op.ToString()),
    };
}
