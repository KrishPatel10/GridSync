namespace GridSync.Core.Rows;

/// <summary>
/// Keys that sort between any two neighbours, so a row can be inserted anywhere without renumbering
/// the rows around it. This is what lets two people insert rows at the same time: each picks a key
/// between the same two neighbours, and no other row has to move.
///
/// A key is a string of base-62 digits ("0-9A-Za-z", which is also their ASCII order, so plain
/// ordinal string comparison sorts keys correctly), read as a fraction: "V" is about one half,
/// "V5" a little more. Two rules keep it sound: a key never ends in "0" (it would equal the key
/// without it, "V0" == "V", so two spellings of one position), and Between needs before &lt; after.
///
/// Mirrors client/src/app/rows/fractional-index.ts. Both must give identical keys, so the shared
/// vectors in spec/fractional-index-vectors.json are run by both test suites.
/// </summary>
public static class FractionalIndex
{
    public const string Digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    private const int Base = 62;

    /// <summary>Width of a base row's key. Four digits reach 62^4 = 14.7 million rows.</summary>
    private const int BaseRowWidth = 4;

    /// <summary>
    /// A key strictly between two others. Null <paramref name="before"/> (or empty) means "before
    /// everything", null <paramref name="after"/> means "after everything".
    /// </summary>
    public static string Between(string? before, string? after)
    {
        before ??= string.Empty;
        Validate(before, nameof(before), allowEmpty: true);
        if (after is not null) Validate(after, nameof(after), allowEmpty: false);

        if (after is not null && string.CompareOrdinal(before, after) >= 0)
            throw new ArgumentException($"'{before}' must sort before '{after}'.");

        return Midpoint(before, after);
    }

    /// <summary>
    /// The key of the Nth row a sheet starts with. The sheet's initial rows are implicit (100,000
    /// records nobody has touched are not worth storing), so their keys are computed, not stored:
    /// the index in base 62, padded to a fixed width so they sort in index order, plus a "V" so the
    /// key never ends in "0" and there is always room to insert between two neighbouring rows.
    /// </summary>
    public static string ForBaseRow(int index)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(index);

        var digits = new char[BaseRowWidth];
        var rest = index;
        for (var i = BaseRowWidth - 1; i >= 0; i--)
        {
            digits[i] = Digits[rest % Base];
            rest /= Base;
        }

        if (rest != 0) throw new ArgumentOutOfRangeException(nameof(index), "Too many rows for a four digit key.");
        return new string(digits) + "V";
    }

    /// <summary>True when <paramref name="key"/> is a well formed key: non-empty, only key digits, not ending in "0".</summary>
    public static bool IsValid(string? key)
    {
        if (string.IsNullOrEmpty(key) || key[^1] == '0') return false;
        foreach (var c in key)
        {
            if (Digits.IndexOf(c) < 0) return false;
        }

        return true;
    }

    private static string Midpoint(string a, string? b)
    {
        if (b is not null)
        {
            // Keys that share a prefix share it in the answer: only the part after it matters. A
            // key shorter than the prefix counts as padded with zeros ("1" is "100...").
            var n = 0;
            while (n < b.Length && (n < a.Length ? a[n] : '0') == b[n]) n++;
            if (n > 0) return b[..n] + Midpoint(n < a.Length ? a[n..] : string.Empty, b[n..]);
        }

        var digitA = a.Length > 0 ? Digits.IndexOf(a[0]) : 0;
        var digitB = b is not null ? Digits.IndexOf(b[0]) : Base;

        if (digitB - digitA > 1) return Digits[(digitA + digitB + 1) / 2].ToString(); // room between the first digits

        // The first digits are neighbours (or equal, only possible when before is empty), so a one
        // digit key cannot fit between. Either shorten to b's first digit, which is above a and a
        // proper prefix of b (so below it), or keep a's digit and go between the rest of a and "the end".
        if (b is not null && b.Length > 1) return b[..1];
        return Digits[digitA] + Midpoint(a.Length > 0 ? a[1..] : string.Empty, null);
    }

    private static void Validate(string key, string name, bool allowEmpty)
    {
        if (key.Length == 0)
        {
            if (allowEmpty) return;
            throw new ArgumentException("A key cannot be empty.", name);
        }

        foreach (var c in key)
        {
            if (Digits.IndexOf(c) < 0) throw new ArgumentException($"'{key}' has a character outside 0-9A-Za-z.", name);
        }

        if (key[^1] == '0') throw new ArgumentException($"'{key}' ends in 0, which is another spelling of a shorter key.", name);
    }
}
