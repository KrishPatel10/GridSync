using System.Globalization;
using System.Text;

namespace GridSync.Core.Formulas;

/// <summary>
/// Step one of reading a formula: chop the text into tokens ("=SUM(A1:A3)*2" becomes SUM ( A1 : A3
/// ) * 2). It knows nothing about precedence or nesting; that is the parser's job.
///
/// Everything here is ASCII-only and hand-rolled (no regex, no char.IsLetter) so the TypeScript
/// tokenizer can follow the same rules character for character.
/// </summary>
public static class Tokenizer
{
    /// <param name="source">The whole raw cell text, including the leading "=".</param>
    /// <param name="start">Where to begin. The parser passes 1 to skip the "=".</param>
    /// <returns>Tokens followed by one End token.</returns>
    public static List<Token> Tokenize(string source, int start = 0)
    {
        var tokens = new List<Token>();
        var i = start;

        while (i < source.Length)
        {
            var c = source[i];

            if (IsWhitespace(c))
                i++;
            else if (IsDigit(c) || (c == '.' && i + 1 < source.Length && IsDigit(source[i + 1])))
                i = ReadNumber(source, i, tokens);
            else if (c == '"')
                i = ReadString(source, i, tokens);
            else if (CellAddress.IsAsciiLetter(c) || c == '_')
                i = ReadWord(source, i, tokens);
            else
                i = ReadOperator(source, i, tokens);
        }

        tokens.Add(new Token(TokenKind.End, string.Empty, source.Length));
        return tokens;
    }

    private static int ReadNumber(string s, int begin, List<Token> tokens)
    {
        var i = begin;
        while (i < s.Length && IsDigit(s[i])) i++;

        if (i < s.Length && s[i] == '.')
        {
            i++;
            while (i < s.Length && IsDigit(s[i])) i++;
        }

        // Only treat "e" as an exponent when digits follow ("1e3", "2.5E-2"). Otherwise it starts
        // a new token and the parser reports the stray word.
        if (i < s.Length && (s[i] == 'e' || s[i] == 'E'))
        {
            var j = i + 1;
            if (j < s.Length && (s[j] == '+' || s[j] == '-')) j++;
            if (j < s.Length && IsDigit(s[j]))
            {
                while (j < s.Length && IsDigit(s[j])) j++;
                i = j;
            }
        }

        var text = s.Substring(begin, i - begin);
        if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            || !double.IsFinite(value))
            throw new FormulaSyntaxException($"Number '{text}' is out of range", begin);

        tokens.Add(new Token(TokenKind.Number, text, begin, value));
        return i;
    }

    /// <summary>Excel-style: a literal quote inside a string is written as two quotes.</summary>
    private static int ReadString(string s, int begin, List<Token> tokens)
    {
        var text = new StringBuilder();
        var i = begin + 1;

        while (true)
        {
            if (i >= s.Length)
                throw new FormulaSyntaxException("Text is missing its closing quote", begin);

            var c = s[i++];
            if (c != '"')
            {
                text.Append(c);
            }
            else if (i < s.Length && s[i] == '"')
            {
                text.Append('"');
                i++;
            }
            else
            {
                break;
            }
        }

        tokens.Add(new Token(TokenKind.String, text.ToString(), begin));
        return i;
    }

    /// <summary>
    /// One word, three meanings. "SUM(" is a function, "A1" is a cell, anything else is a name.
    /// The "(" lookahead is what lets "LOG10(" be a function even though "LOG10" also looks like
    /// a cell (column LOG, row 10). Excel resolves it the same way.
    /// </summary>
    private static int ReadWord(string s, int begin, List<Token> tokens)
    {
        var i = begin;
        while (i < s.Length && (CellAddress.IsAsciiLetter(s[i]) || IsDigit(s[i]) || s[i] == '_')) i++;

        var text = s.Substring(begin, i - begin);
        var kind =
            i < s.Length && s[i] == '(' ? TokenKind.Function :
            CellAddress.TryParse(text, out _, out _) ? TokenKind.CellRef :
            TokenKind.Name;

        tokens.Add(new Token(kind, text, begin));
        return i;
    }

    private static int ReadOperator(string s, int i, List<Token> tokens)
    {
        var c = s[i];
        var next = i + 1 < s.Length ? s[i + 1] : '\0';

        var (kind, length) = c switch
        {
            '+' => (TokenKind.Plus, 1),
            '-' => (TokenKind.Minus, 1),
            '*' => (TokenKind.Star, 1),
            '/' => (TokenKind.Slash, 1),
            '^' => (TokenKind.Caret, 1),
            '&' => (TokenKind.Ampersand, 1),
            '=' => (TokenKind.Equal, 1),
            '(' => (TokenKind.LeftParen, 1),
            ')' => (TokenKind.RightParen, 1),
            ',' => (TokenKind.Comma, 1),
            ':' => (TokenKind.Colon, 1),
            '<' when next == '=' => (TokenKind.LessOrEqual, 2),
            '<' when next == '>' => (TokenKind.NotEqual, 2),
            '<' => (TokenKind.Less, 1),
            '>' when next == '=' => (TokenKind.GreaterOrEqual, 2),
            '>' => (TokenKind.Greater, 1),
            _ => throw new FormulaSyntaxException($"Unexpected character '{c}'", i),
        };

        tokens.Add(new Token(kind, s.Substring(i, length), i));
        return i + length;
    }

    private static bool IsDigit(char c) => c >= '0' && c <= '9';

    private static bool IsWhitespace(char c) => c is ' ' or '\t' or '\r' or '\n';
}
