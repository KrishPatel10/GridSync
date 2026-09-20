using System.Globalization;

namespace GridSync.Core.Formulas;

/// <summary>
/// ROUND that behaves like Excel: halves round away from zero, and it rounds what the number
/// looks like (2.675 is 2.68), not what the binary double really holds (2.67499999999999982...).
///
/// Math.Round(2.675, 2) gives 2.67 in .NET because it scales by 100 and rounds the double. JS has
/// no matching built-in at all. So rounding is done on the 15-digit decimal text instead, which
/// both engines produce identically, and the result is parsed back to a double.
/// </summary>
public static class DecimalRound
{
    public static double Round(double value, int digitsAfterPoint)
    {
        if (value == 0) return 0;

        var (digits, exponent) = NumberText.Decompose(Math.Abs(value));

        // How many leading digits survive. 123.456 rounded to 1 place: exponent 2, so 2+1+1 = 4
        // digits ("1234"), and the next digit ("5") decides whether to round up.
        var keep = exponent + 1 + digitsAfterPoint;
        if (keep < 0) return 0; // smaller than half a unit: rounds to zero

        string kept;
        if (keep >= digits.Length)
        {
            // Nothing lies beyond the requested place, but the result is still the cleaned-up
            // 15-digit number, so ROUND(0.1+0.2, 1) is exactly 0.3 and not 0.30000000000000004.
            kept = digits;
            keep = digits.Length;
        }
        else
        {
            var roundUp = digits[keep] >= '5';
            kept = roundUp ? NumberText.IncrementDigits(digits[..keep]) : digits[..keep];
            if (kept.Length == 0) return 0;
        }

        // kept is an integer scaled by 10^(exponent + 1 - keep), e.g. "268" and -2 make 2.68.
        var rounded = double.Parse(
            $"{kept}E{exponent + 1 - keep}", NumberStyles.Float, CultureInfo.InvariantCulture);
        return value < 0 ? -rounded : rounded;
    }
}
