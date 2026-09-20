namespace GridSync.Core.Formulas;

/// <summary>
/// A1-style addresses: (row 0, col 0) is "A1". Mirrors columnName/cellAddress in the client's
/// cell-address.ts. Only ASCII letters are accepted, on purpose: char.IsLetter and JavaScript's
/// \p{L} disagree about some Unicode characters, and the two formula engines must never disagree.
/// </summary>
public static class CellAddress
{
    /// <summary>Excel's widest column is "XFD" (3 letters). Longer words are names, not cells.</summary>
    private const int MaxColumnLetters = 3;

    /// <summary>Nine digits always fit in an int, so parsing the row can never overflow.</summary>
    private const int MaxRowDigits = 9;

    /// <summary>0 -> "A", 25 -> "Z", 26 -> "AA": bijective base 26, so there is no zero digit.</summary>
    public static string ColumnName(int col)
    {
        var name = string.Empty;
        for (var n = col + 1; n > 0; n = (n - 1) / 26)
            name = (char)('A' + (n - 1) % 26) + name;
        return name;
    }

    public static string ToA1(int row, int col) => ColumnName(col) + (row + 1);

    /// <summary>
    /// Parses "A1", "b12", "XFD1048576". Rejects "A0", "1A", "A1B", and anything with more than
    /// three letters. Says nothing about whether the cell is inside the sheet: that is the
    /// evaluator's job, and it reports #REF!.
    /// </summary>
    public static bool TryParse(ReadOnlySpan<char> text, out int row, out int col)
    {
        row = col = 0;

        var letters = 0;
        var column = 0;
        while (letters < text.Length && IsAsciiLetter(text[letters]))
        {
            if (letters == MaxColumnLetters) return false;
            column = column * 26 + ((text[letters] | 0x20) - 'a' + 1);
            letters++;
        }

        var digits = text.Length - letters;
        if (letters == 0 || digits == 0 || digits > MaxRowDigits || text[letters] == '0') return false;

        var rowNumber = 0;
        for (var i = letters; i < text.Length; i++)
        {
            var d = text[i] - '0';
            if ((uint)d > 9) return false;
            rowNumber = rowNumber * 10 + d;
        }

        row = rowNumber - 1;
        col = column - 1;
        return true;
    }

    internal static bool IsAsciiLetter(char c) => (uint)((c | 0x20) - 'a') <= 'z' - 'a';
}
