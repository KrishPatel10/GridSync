namespace GridSync.Core.Formulas;

/// <summary>
/// Turns tokens into an AST with a Pratt (precedence-climbing) parser.
///
/// The idea: every infix operator has a binding power, and ParseExpression(minPower) keeps
/// absorbing operators as long as they bind tighter than minPower. For "1+2*3": after "1 +" the
/// parser asks for a right-hand side at the power of "+". It reads "2", sees "*" (tighter than
/// "+"), so "*" takes the "2" and "3" first. Precedence falls out of one loop, no grammar tables.
///
/// Precedence follows Excel, lowest to highest: comparisons, &amp;, + -, * /, ^, unary minus.
/// Two Excel quirks are deliberate and pinned by tests: unary minus binds tighter than ^ (so
/// -2^2 is 4, not -4), and ^ is left-associative (so 2^3^2 is 64, not 512).
/// </summary>
public static class FormulaParser
{
    /// <summary>
    /// How many parse calls may be open at once. The parser is recursive, and .NET cannot catch a
    /// stack overflow: it kills the process. A 10,000-character cell of "((((...(" must fail with
    /// an ordinary exception instead. Excel's own limit for nested functions is also 64.
    /// </summary>
    public const int MaxDepth = 64;

    private const int ComparisonPower = 10;
    private const int ConcatPower = 20;
    private const int AdditivePower = 30;
    private const int MultiplicativePower = 40;
    private const int ExponentPower = 50;
    private const int UnaryPower = 60;

    /// <param name="formula">Raw cell text, including the leading "=".</param>
    /// <exception cref="FormulaSyntaxException">The text is not a valid formula.</exception>
    public static Expr Parse(string formula)
    {
        if (formula.Length == 0 || formula[0] != '=')
            throw new FormulaSyntaxException("A formula must start with '='", 0);

        return new ParserState(Tokenizer.Tokenize(formula, start: 1)).ParseAll();
    }

    private sealed class ParserState(List<Token> tokens)
    {
        private int _pos;
        private int _depth;

        private Token Peek => tokens[_pos];

        /// <summary>Consumes and returns the next token. The End token is never consumed.</summary>
        private Token Next()
        {
            var token = tokens[_pos];
            if (token.Kind != TokenKind.End) _pos++;
            return token;
        }

        public Expr ParseAll()
        {
            var expr = ParseExpression(0);
            if (Peek.Kind != TokenKind.End) throw Unexpected(Peek);
            return expr;
        }

        private Expr ParseExpression(int minPower)
        {
            if (++_depth > MaxDepth)
                throw new FormulaSyntaxException("Formula is nested too deeply", Peek.Position);

            var left = ParsePrefix();

            // "power <= minPower" stops on equal power, which is what makes 1-2-3 group as (1-2)-3.
            // Left-associative chains also run in this loop instead of recursing, so a long
            // "1+1+1+..." does not consume stack.
            while (TryGetInfix(Peek.Kind, out var op, out var power) && power > minPower)
            {
                Next();
                var right = ParseExpression(power);
                left = new BinaryExpr(op, left, right);
            }

            _depth--;
            return left;
        }

        /// <summary>
        /// Anything that can start an expression. The same "-" token is unary here (start of an
        /// expression) and binary in the loop above (after a complete operand): position, not
        /// the token, decides which one it is.
        /// </summary>
        private Expr ParsePrefix()
        {
            var token = Next();
            switch (token.Kind)
            {
                case TokenKind.Number:
                    return new NumberLiteral(token.Number);

                case TokenKind.String:
                    return new StringLiteral(token.Text);

                case TokenKind.CellRef:
                    return ParseCellOrRange(token);

                case TokenKind.Name:
                    return new NameRef(token.Text.ToUpperInvariant());

                case TokenKind.Function:
                    return ParseCall(token);

                case TokenKind.Minus:
                    // Operand at UnaryPower: it swallows nothing but a single operand, so "-2^2"
                    // parses as (-2)^2 and "2^-1" still works (the "-" starts the right side of "^").
                    return new Negate(ParseExpression(UnaryPower));

                case TokenKind.LeftParen:
                {
                    var inner = ParseExpression(0);
                    if (Peek.Kind != TokenKind.RightParen)
                        throw new FormulaSyntaxException("Expected ')'", Peek.Position);
                    Next();
                    return inner;
                }

                default:
                    throw Unexpected(token);
            }
        }

        /// <summary>
        /// The ":" is handled here instead of as an operator: a range is only ever cell:cell, so
        /// "A1:5" or "SUM(1):B2" are syntax errors and never reach the evaluator.
        /// </summary>
        private Expr ParseCellOrRange(Token first)
        {
            var start = ToCellRef(first);
            if (Peek.Kind != TokenKind.Colon) return start;

            Next();
            var second = Next();
            if (second.Kind != TokenKind.CellRef)
                throw new FormulaSyntaxException("Expected a cell address after ':'", second.Position);

            var end = ToCellRef(second);
            return new RangeRef(
                new CellRef(Math.Min(start.Row, end.Row), Math.Min(start.Col, end.Col)),
                new CellRef(Math.Max(start.Row, end.Row), Math.Max(start.Col, end.Col)));
        }

        private Expr ParseCall(Token name)
        {
            Next(); // the "(" the tokenizer saw right after the name
            var args = new List<Expr>();

            if (Peek.Kind != TokenKind.RightParen)
            {
                args.Add(ParseExpression(0));
                while (Peek.Kind == TokenKind.Comma)
                {
                    Next();
                    args.Add(ParseExpression(0));
                }
            }

            if (Peek.Kind != TokenKind.RightParen)
                throw new FormulaSyntaxException("Expected ',' or ')'", Peek.Position);
            Next();

            return new FunctionCall(name.Text.ToUpperInvariant(), args);
        }

        private static CellRef ToCellRef(Token token)
        {
            CellAddress.TryParse(token.Text, out var row, out var col); // the tokenizer already validated it
            return new CellRef(row, col);
        }

        private static bool TryGetInfix(TokenKind kind, out BinaryOp op, out int power)
        {
            (op, power) = kind switch
            {
                TokenKind.Equal => (BinaryOp.Equal, ComparisonPower),
                TokenKind.NotEqual => (BinaryOp.NotEqual, ComparisonPower),
                TokenKind.Less => (BinaryOp.Less, ComparisonPower),
                TokenKind.LessOrEqual => (BinaryOp.LessOrEqual, ComparisonPower),
                TokenKind.Greater => (BinaryOp.Greater, ComparisonPower),
                TokenKind.GreaterOrEqual => (BinaryOp.GreaterOrEqual, ComparisonPower),
                TokenKind.Ampersand => (BinaryOp.Concat, ConcatPower),
                TokenKind.Plus => (BinaryOp.Add, AdditivePower),
                TokenKind.Minus => (BinaryOp.Subtract, AdditivePower),
                TokenKind.Star => (BinaryOp.Multiply, MultiplicativePower),
                TokenKind.Slash => (BinaryOp.Divide, MultiplicativePower),
                TokenKind.Caret => (BinaryOp.Power, ExponentPower),
                _ => (default, 0),
            };
            return power != 0;
        }

        private static FormulaSyntaxException Unexpected(Token token) =>
            token.Kind == TokenKind.End
                ? new FormulaSyntaxException("Formula ended unexpectedly", token.Position)
                : new FormulaSyntaxException($"Unexpected '{token.Text}'", token.Position);
    }
}
