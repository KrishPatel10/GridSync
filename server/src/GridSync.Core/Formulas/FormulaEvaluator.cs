namespace GridSync.Core.Formulas;

/// <summary>
/// Walks a parsed formula and produces a value. Rules follow Excel where it has a clear answer;
/// every place this deliberately differs is called out, and the shared vectors pin all of it so
/// the TypeScript engine cannot drift.
///
/// Errors are values. The first error met (left operand before right, arguments left to right)
/// becomes the result. IF is lazy: only the chosen branch is evaluated.
/// </summary>
public static class FormulaEvaluator
{
    /// <summary>Full pipeline for raw cell text that starts with "=".</summary>
    public static FormulaValue Evaluate(string formula, ICellReader cells)
    {
        Expr ast;
        try
        {
            ast = FormulaParser.Parse(formula);
        }
        catch (FormulaSyntaxException)
        {
            return FormulaValue.FromError(FormulaError.Syntax);
        }

        return Evaluate(ast, cells);
    }

    /// <summary>
    /// For callers that parse once and evaluate many times (the dependency graph). An empty
    /// result is shown as 0, like "=A1" does in Excel when A1 is blank.
    /// </summary>
    public static FormulaValue Evaluate(Expr expr, ICellReader cells)
    {
        var value = Eval(expr, cells);
        return value.Kind == ValueKind.Empty ? FormulaValue.FromNumber(0) : value;
    }

    private static FormulaValue Eval(Expr expr, ICellReader cells) => expr switch
    {
        NumberLiteral n => FormulaValue.FromNumber(n.Value),
        StringLiteral s => FormulaValue.FromText(s.Value),
        CellRef c => ReadCell(c, cells),
        // A range only means something as a function argument (SUM(A1:A3)). Anywhere else, like
        // "=A1:A3+1", it would need array behaviour we do not have.
        RangeRef => Fail(FormulaError.Value),
        NameRef n => EvalName(n),
        Negate n => EvalNegate(n, cells),
        BinaryExpr b => EvalBinary(b, cells),
        FunctionCall f => EvalCall(f, cells),
        _ => throw new NotSupportedException(expr.GetType().Name),
    };

    private static FormulaValue Fail(FormulaError error) => FormulaValue.FromError(error);

    private static FormulaValue Finite(double value) =>
        double.IsFinite(value) ? FormulaValue.FromNumber(value) : Fail(FormulaError.Num);

    private static FormulaValue ReadCell(CellRef cell, ICellReader cells) =>
        InSheet(cell, cells.Dimensions) ? cells.GetValue(cell.Row, cell.Col) : Fail(FormulaError.Ref);

    private static bool InSheet(CellRef cell, SheetDimensions dims) =>
        cell.Row < dims.Rows && cell.Col < dims.Cols;

    private static FormulaValue EvalName(NameRef name) => name.Name switch
    {
        "TRUE" => FormulaValue.FromBoolean(true),
        "FALSE" => FormulaValue.FromBoolean(false),
        _ => Fail(FormulaError.Name),
    };

    private static FormulaValue EvalNegate(Negate negate, ICellReader cells)
    {
        var operand = Eval(negate.Operand, cells);
        return TryNumber(operand, out var number, out var error) ? FormulaValue.FromNumber(-number) : error;
    }

    // ---- Binary operators ------------------------------------------------------------------

    /// <summary>
    /// "1+2+3+4" parses to a tree that is deep on the left: ((1+2)+3)+4. Recursing down it would
    /// use a stack frame per term, and a 10,000-character cell allows thousands of terms. So walk
    /// down the left side with a loop, then fold back up. Recursion only happens for right-hand
    /// sides, and the parser's nesting limit already bounds that.
    /// </summary>
    private static FormulaValue EvalBinary(BinaryExpr root, ICellReader cells)
    {
        if (root.Left is not BinaryExpr)
            return Apply(root.Op, Eval(root.Left, cells), root.Right, cells);

        var spine = new List<BinaryExpr>();
        Expr node = root;
        while (node is BinaryExpr binary)
        {
            spine.Add(binary);
            node = binary.Left;
        }

        var accumulated = Eval(node, cells);
        for (var i = spine.Count - 1; i >= 0; i--)
            accumulated = Apply(spine[i].Op, accumulated, spine[i].Right, cells);
        return accumulated;
    }

    /// <summary>
    /// Order of checks: left error, right error, then coercion failures. Once the left side is an
    /// error the right side is not even evaluated.
    /// </summary>
    private static FormulaValue Apply(BinaryOp op, FormulaValue left, Expr rightExpr, ICellReader cells)
    {
        if (left.IsError) return left;
        var right = Eval(rightExpr, cells);
        if (right.IsError) return right;

        switch (op)
        {
            case BinaryOp.Concat:
                return FormulaValue.FromText(AsText(left) + AsText(right));

            case BinaryOp.Equal:
            case BinaryOp.NotEqual:
            case BinaryOp.Less:
            case BinaryOp.LessOrEqual:
            case BinaryOp.Greater:
            case BinaryOp.GreaterOrEqual:
                return FormulaValue.FromBoolean(Satisfies(op, Compare(left, right)));
        }

        if (!TryNumber(left, out var l, out var leftError)) return leftError;
        if (!TryNumber(right, out var r, out var rightError)) return rightError;

        return op switch
        {
            BinaryOp.Add => Finite(l + r),
            BinaryOp.Subtract => Finite(l - r),
            BinaryOp.Multiply => Finite(l * r),
            BinaryOp.Divide => r == 0 ? Fail(FormulaError.DivideByZero) : Finite(l / r),
            BinaryOp.Power => Power(l, r),
            _ => throw new NotSupportedException(op.ToString()),
        };
    }

    /// <summary>
    /// Excel: 0^0 is #NUM! (not 1) and 0^-1 is #DIV/0!. Math.Pow is used for everything else. It
    /// is the one place where C# and JS may differ in the last digit for non-integer exponents,
    /// so the vectors stick to results that are exact.
    /// </summary>
    private static FormulaValue Power(double b, double e)
    {
        if (b == 0 && e == 0) return Fail(FormulaError.Num);
        if (b == 0 && e < 0) return Fail(FormulaError.DivideByZero);
        return Finite(Math.Pow(b, e));
    }

    private static bool Satisfies(BinaryOp op, int comparison) => op switch
    {
        BinaryOp.Equal => comparison == 0,
        BinaryOp.NotEqual => comparison != 0,
        BinaryOp.Less => comparison < 0,
        BinaryOp.LessOrEqual => comparison <= 0,
        BinaryOp.Greater => comparison > 0,
        _ => comparison >= 0,
    };

    /// <summary>
    /// Excel's ordering across types: numbers are below text, text is below booleans. Text
    /// ignores ASCII case only: full Unicode case folding differs between .NET and JS ("ß"), and
    /// the engines must agree. Comparing exactly on doubles means 0.1+0.2=0.3 is FALSE; Excel
    /// quietly forgives that, this engine does not.
    /// </summary>
    private static int Compare(FormulaValue left, FormulaValue right)
    {
        if (left.Kind == ValueKind.Empty && right.Kind == ValueKind.Empty) return 0;
        if (left.Kind == ValueKind.Empty) left = BlankLike(right);
        if (right.Kind == ValueKind.Empty) right = BlankLike(left);

        if (left.Kind != right.Kind) return Rank(left.Kind) < Rank(right.Kind) ? -1 : 1;

        return left.Kind switch
        {
            ValueKind.Text => CompareIgnoringAsciiCase(left.Text, right.Text),
            _ => left.Number.CompareTo(right.Number), // numbers, and booleans stored as 0 or 1
        };
    }

    /// <summary>What an empty cell counts as when compared with something: 0, "" or FALSE.</summary>
    private static FormulaValue BlankLike(FormulaValue other) => other.Kind switch
    {
        ValueKind.Text => FormulaValue.FromText(string.Empty),
        ValueKind.Boolean => FormulaValue.FromBoolean(false),
        _ => FormulaValue.FromNumber(0),
    };

    private static int Rank(ValueKind kind) => kind switch
    {
        ValueKind.Number => 0,
        ValueKind.Text => 1,
        _ => 2,
    };

    private static int CompareIgnoringAsciiCase(string a, string b)
    {
        var shared = Math.Min(a.Length, b.Length);
        for (var i = 0; i < shared; i++)
        {
            var x = FoldAscii(a[i]);
            var y = FoldAscii(b[i]);
            if (x != y) return x < y ? -1 : 1;
        }
        return a.Length.CompareTo(b.Length);
    }

    private static char FoldAscii(char c) => c >= 'A' && c <= 'Z' ? (char)(c + 32) : c;

    // ---- Coercions -------------------------------------------------------------------------

    /// <summary>
    /// Number for arithmetic: blank is 0, TRUE is 1, and text works only if the whole text is a
    /// number ("5" yes, "hello" no, which is #VALUE!). An error passes straight through.
    /// </summary>
    private static bool TryNumber(FormulaValue value, out double number, out FormulaValue error)
    {
        error = default;
        number = 0;

        switch (value.Kind)
        {
            case ValueKind.Empty:
                return true;
            case ValueKind.Number:
            case ValueKind.Boolean:
                number = value.Number;
                return true;
            case ValueKind.Text when NumberText.TryParse(value.Text, out number):
                return true;
            case ValueKind.Error:
                error = value;
                return false;
            default:
                error = Fail(FormulaError.Value);
                return false;
        }
    }

    private static bool TryBoolean(FormulaValue value, out bool result, out FormulaValue error)
    {
        error = default;
        result = false;

        switch (value.Kind)
        {
            case ValueKind.Empty:
                return true;
            case ValueKind.Boolean:
            case ValueKind.Number:
                result = value.Number != 0;
                return true;
            case ValueKind.Text when CompareIgnoringAsciiCase(value.Text, "TRUE") == 0:
                result = true;
                return true;
            case ValueKind.Text when CompareIgnoringAsciiCase(value.Text, "FALSE") == 0:
                return true;
            case ValueKind.Error:
                error = value;
                return false;
            default:
                error = Fail(FormulaError.Value);
                return false;
        }
    }

    private static string AsText(FormulaValue value) => value.ToDisplayString();

    // ---- Functions -------------------------------------------------------------------------

    private static FormulaValue EvalCall(FunctionCall call, ICellReader cells) => call.Name switch
    {
        "SUM" => Aggregate(call, cells, Aggregation.Sum),
        "AVERAGE" => Aggregate(call, cells, Aggregation.Average),
        "MIN" => Aggregate(call, cells, Aggregation.Min),
        "MAX" => Aggregate(call, cells, Aggregation.Max),
        "COUNT" => Aggregate(call, cells, Aggregation.Count),
        "IF" => EvalIf(call, cells),
        "ROUND" => EvalRound(call, cells),
        _ => Fail(FormulaError.Name),
    };

    private static FormulaValue EvalIf(FunctionCall call, ICellReader cells)
    {
        if (call.Args.Count is < 2 or > 3) return Fail(FormulaError.Value);

        if (!TryBoolean(Eval(call.Args[0], cells), out var condition, out var error)) return error;
        if (condition) return Eval(call.Args[1], cells);
        return call.Args.Count == 3 ? Eval(call.Args[2], cells) : FormulaValue.FromBoolean(false);
    }

    private static FormulaValue EvalRound(FunctionCall call, ICellReader cells)
    {
        if (call.Args.Count != 2) return Fail(FormulaError.Value);

        if (!TryNumber(Eval(call.Args[0], cells), out var number, out var error)) return error;
        if (!TryNumber(Eval(call.Args[1], cells), out var places, out error)) return error;

        // Excel drops the fraction of the digit count. The clamp keeps the int cast safe; nothing
        // real needs more than a few hundred places.
        var digits = (int)Math.Clamp(Math.Truncate(places), -1000, 1000);
        return Finite(DecimalRound.Round(number, digits));
    }

    private enum Aggregation { Sum, Average, Min, Max, Count }

    private struct Totals
    {
        public double Sum;
        public long Count;
        public double Min;
        public double Max;

        public void Add(double number)
        {
            if (Count == 0 || number < Min) Min = number;
            if (Count == 0 || number > Max) Max = number;
            Sum += number;
            Count++;
        }
    }

    /// <summary>
    /// SUM, AVERAGE, MIN, MAX and COUNT share one rule about what counts, which is Excel's:
    /// - A cell or range reference contributes only its numbers. Text, booleans and blanks in it
    ///   are skipped, so SUM(A1:A9) survives a header row.
    /// - Anything else typed as an argument (SUM(1, "2", TRUE, A1+1)) is coerced like arithmetic.
    /// - An error stops everything and becomes the result, except in COUNT, which ignores errors.
    /// Cells are read row by row, left to right: floating-point addition is not associative, so
    /// the order is part of the spec.
    /// </summary>
    private static FormulaValue Aggregate(FunctionCall call, ICellReader cells, Aggregation kind)
    {
        if (call.Args.Count == 0) return Fail(FormulaError.Value);

        var ignoreErrors = kind == Aggregation.Count;
        var totals = new Totals();

        foreach (var arg in call.Args)
        {
            FormulaValue? failure = arg switch
            {
                RangeRef range => AddRange(range, cells, ref totals, ignoreErrors),
                CellRef cell => AddRange(new RangeRef(cell, cell), cells, ref totals, ignoreErrors),
                _ => AddValue(Eval(arg, cells), ref totals, ignoreErrors),
            };
            if (failure is { } error) return error;
        }

        return kind switch
        {
            Aggregation.Sum => Finite(totals.Sum),
            Aggregation.Average => totals.Count == 0
                ? Fail(FormulaError.DivideByZero)
                : Finite(totals.Sum / totals.Count),
            Aggregation.Min => FormulaValue.FromNumber(totals.Count == 0 ? 0 : totals.Min),
            Aggregation.Max => FormulaValue.FromNumber(totals.Count == 0 ? 0 : totals.Max),
            _ => FormulaValue.FromNumber(totals.Count),
        };
    }

    private static FormulaValue? AddRange(RangeRef range, ICellReader cells, ref Totals totals, bool ignoreErrors)
    {
        if (!InSheet(range.BottomRight, cells.Dimensions)) return Fail(FormulaError.Ref);

        for (var row = range.TopLeft.Row; row <= range.BottomRight.Row; row++)
        {
            for (var col = range.TopLeft.Col; col <= range.BottomRight.Col; col++)
            {
                var value = cells.GetValue(row, col);
                if (value.Kind == ValueKind.Number) totals.Add(value.Number);
                else if (value.IsError && !ignoreErrors) return value;
            }
        }
        return null;
    }

    private static FormulaValue? AddValue(FormulaValue value, ref Totals totals, bool ignoreErrors)
    {
        if (value.IsError) return ignoreErrors ? null : value;

        if (TryNumber(value, out var number, out _))
        {
            totals.Add(number);
            return null;
        }

        // Text that is not a number: skipped by COUNT, #VALUE! for everything else.
        return ignoreErrors ? null : Fail(FormulaError.Value);
    }
}
