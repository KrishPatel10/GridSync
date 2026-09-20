namespace GridSync.Core.Formulas;

/// <summary>
/// The tree a formula parses into. "=1+2*3" becomes Binary(Add, 1, Binary(Multiply, 2, 3)): the
/// shape of the tree is the precedence, so the evaluator never has to think about it.
/// </summary>
public abstract record Expr;

public sealed record NumberLiteral(double Value) : Expr;

public sealed record StringLiteral(string Value) : Expr;

/// <summary>Zero-based, matching the (row, col) used by CellOp and the client's cellKey.</summary>
public sealed record CellRef(int Row, int Col) : Expr;

/// <summary>Always normalized: TopLeft has the smaller row and column, so "B2:A1" is "A1:B2".</summary>
public sealed record RangeRef(CellRef TopLeft, CellRef BottomRight) : Expr;

/// <summary>
/// A bare word like "TAX". The parser accepts it and the evaluator turns it into #NAME?, so a
/// formula with a typo still parses and shows an error instead of being unparseable.
/// </summary>
public sealed record NameRef(string Name) : Expr;

public sealed record Negate(Expr Operand) : Expr;

public enum BinaryOp
{
    Add,
    Subtract,
    Multiply,
    Divide,
    Power,
    Concat,
    Equal,
    NotEqual,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
}

public sealed record BinaryExpr(BinaryOp Op, Expr Left, Expr Right) : Expr;

/// <summary>
/// Name is upper-cased. The parser does not know which functions exist; an unknown one becomes
/// #NAME? at evaluation time, which keeps the parser independent of the function library.
/// </summary>
public sealed record FunctionCall(string Name, IReadOnlyList<Expr> Args) : Expr;
