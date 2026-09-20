namespace GridSync.Core.Formulas;

public enum TokenKind
{
    Number,
    String,
    /// <summary>A1-style cell address such as "B12".</summary>
    CellRef,
    /// <summary>A bare word that is not a cell and is not followed by "(", such as "TAX".</summary>
    Name,
    /// <summary>A word immediately followed by "(", such as "SUM". The "(" is a separate token.</summary>
    Function,
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    Ampersand,
    Equal,
    NotEqual,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
    LeftParen,
    RightParen,
    Comma,
    Colon,
    End,
}

/// <param name="Text">
/// The source text, except for strings, where it is the contents with the quotes removed and
/// "" collapsed to ".
/// </param>
/// <param name="Position">Index into the original formula text, for error messages.</param>
/// <param name="Number">The parsed value; only meaningful for TokenKind.Number.</param>
public readonly record struct Token(TokenKind Kind, string Text, int Position, double Number = 0);

/// <summary>
/// The formula text cannot be tokenized or parsed. This is an exception rather than a #ERROR
/// value because it happens once, when a cell's raw text changes, never during recalculation.
/// </summary>
public sealed class FormulaSyntaxException(string message, int position) : Exception(message)
{
    public int Position { get; } = position;
}
