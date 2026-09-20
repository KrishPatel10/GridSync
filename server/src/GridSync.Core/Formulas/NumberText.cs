using System.Globalization;

namespace GridSync.Core.Formulas;

/// <summary>
/// Numbers to text and back, with rules that are spelled out instead of inherited from the
/// platform. C# and JavaScript print doubles differently (exponent style, when they switch to
/// it), so the TypeScript port implements exactly this algorithm and the shared vectors check it.
///
/// The one thing both platforms do identically is correct rounding: formatting a double to 15
/// significant digits gives the same digits in .NET and in JS. Everything below builds on that.
/// </summary>
public static class NumberText
{
    /// <summary>
    /// Excel shows and concatenates numbers to 15 significant digits, which is why 0.1+0.2
    /// displays as 0.3 even though the double is 0.30000000000000004.
    /// </summary>
    private const int SignificantDigits = 15;

    /// <summary>
    /// Whole-string numbers only: optional sign, digits with an optional point, optional
    /// exponent. No spaces, no thousands separators, no "Infinity", no hex. Hand-scanned instead
    /// of using double.TryParse alone because the platform parsers accept different extras.
    /// </summary>
    public static bool TryParse(string text, out double value)
    {
        value = 0;
        var i = 0;
        if (i < text.Length && (text[i] == '+' || text[i] == '-')) i++;

        var mantissaDigits = 0;
        while (i < text.Length && IsDigit(text[i])) { i++; mantissaDigits++; }
        if (i < text.Length && text[i] == '.')
        {
            i++;
            while (i < text.Length && IsDigit(text[i])) { i++; mantissaDigits++; }
        }
        if (mantissaDigits == 0) return false;

        if (i < text.Length && (text[i] == 'e' || text[i] == 'E'))
        {
            i++;
            if (i < text.Length && (text[i] == '+' || text[i] == '-')) i++;
            var exponentDigits = 0;
            while (i < text.Length && IsDigit(text[i])) { i++; exponentDigits++; }
            if (exponentDigits == 0) return false;
        }

        if (i != text.Length) return false;

        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value)
            && double.IsFinite(value);
    }

    /// <summary>
    /// 15 significant digits, no trailing zeros, no exponent below 1e-5 or from 1e15 up:
    /// 0.3, 100, 123.456, 0.00001, then 1E-06 and 1E+15 in scientific style.
    /// </summary>
    public static string ToText(double value)
    {
        if (value == 0) return "0";

        var (digits, exponent) = Decompose(Math.Abs(value));
        var sign = value < 0 ? "-" : string.Empty;

        if (exponent >= SignificantDigits || exponent < -5)
        {
            var mantissa = digits.Length == 1 ? digits : digits[..1] + "." + digits[1..];
            var exponentSign = exponent < 0 ? "-" : "+";
            return $"{sign}{mantissa}E{exponentSign}{Math.Abs(exponent):00}";
        }

        if (exponent >= 0)
        {
            var integerLength = exponent + 1;
            return digits.Length <= integerLength
                ? sign + digits + new string('0', integerLength - digits.Length)
                : sign + digits[..integerLength] + "." + digits[integerLength..];
        }

        return sign + "0." + new string('0', -exponent - 1) + digits;
    }

    /// <summary>
    /// Splits a positive finite number into its first 15 significant digits (trailing zeros
    /// removed) and the decimal exponent of the first digit: 123.456 is ("123456", 2).
    /// </summary>
    internal static (string Digits, int Exponent) Decompose(double magnitude)
    {
        // "E14" is one digit, a point, and 14 more: "1.23456000000000E+002".
        var s = magnitude.ToString("E14", CultureInfo.InvariantCulture);
        var e = s.IndexOf('E');
        var exponent = int.Parse(s.AsSpan(e + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        var digits = (s[0] + s.Substring(2, SignificantDigits - 1)).TrimEnd('0');
        return (digits.Length == 0 ? "0" : digits, exponent);
    }

    private static bool IsDigit(char c) => c >= '0' && c <= '9';
}
