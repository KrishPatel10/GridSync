import { isDigit } from './chars';

/**
 * Numbers to text and back, with rules that are spelled out instead of inherited from the
 * platform. Mirrors NumberText.cs: C# and JavaScript print doubles differently (exponent style,
 * when they switch to it), so both engines implement exactly this algorithm and the shared
 * vectors check it.
 *
 * The one thing both platforms do identically is correct rounding: formatting a double to 15
 * significant digits gives the same digits in .NET and in JS. Everything below builds on that.
 */

/**
 * Excel shows and concatenates numbers to 15 significant digits, which is why 0.1+0.2 displays as
 * 0.3 even though the double is 0.30000000000000004.
 */
const SIGNIFICANT_DIGITS = 15;

/**
 * Whole-string numbers only: optional sign, digits with an optional point, optional exponent. No
 * spaces, no thousands separators, no "Infinity", no hex. Hand-scanned because Number() accepts
 * extras ("0x10", " 5 ", "") that the C# parser does not.
 */
export function tryParseNumber(text: string): number | null {
  let i = 0;
  if (text.charAt(i) === '+' || text.charAt(i) === '-') i++;

  let mantissaDigits = 0;
  while (isDigit(text.charAt(i))) {
    i++;
    mantissaDigits++;
  }
  if (text.charAt(i) === '.') {
    i++;
    while (isDigit(text.charAt(i))) {
      i++;
      mantissaDigits++;
    }
  }
  if (mantissaDigits === 0) return null;

  if (text.charAt(i) === 'e' || text.charAt(i) === 'E') {
    i++;
    if (text.charAt(i) === '+' || text.charAt(i) === '-') i++;
    let exponentDigits = 0;
    while (isDigit(text.charAt(i))) {
      i++;
      exponentDigits++;
    }
    if (exponentDigits === 0) return null;
  }

  if (i !== text.length) return null;

  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * 15 significant digits, no trailing zeros, no exponent below 1e-5 or from 1e15 up: 0.3, 100,
 * 123.456, 0.00001, then 1E-06 and 1E+15 in scientific style.
 */
export function numberToText(value: number): string {
  if (value === 0) return '0';

  const { digits, exponent } = decompose(Math.abs(value));
  const sign = value < 0 ? '-' : '';

  if (exponent >= SIGNIFICANT_DIGITS || exponent < -5) {
    const mantissa = digits.length === 1 ? digits : `${digits.substring(0, 1)}.${digits.substring(1)}`;
    const exponentSign = exponent < 0 ? '-' : '+';
    return `${sign}${mantissa}E${exponentSign}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }

  if (exponent >= 0) {
    const integerLength = exponent + 1;
    return digits.length <= integerLength
      ? sign + digits + '0'.repeat(integerLength - digits.length)
      : `${sign}${digits.substring(0, integerLength)}.${digits.substring(integerLength)}`;
  }

  return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
}

/**
 * Splits a positive finite number into its first 15 significant digits (trailing zeros removed)
 * and the decimal exponent of the first digit: 123.456 is ("123456", 2).
 */
export function decompose(magnitude: number): { digits: string; exponent: number } {
  // toExponential(14) is one digit, a point, and 14 more: "1.23456000000000e+2".
  const [mantissa, exponentText] = magnitude.toExponential(SIGNIFICANT_DIGITS - 1).split('e');
  const digits = (mantissa.charAt(0) + mantissa.substring(2)).replace(/0+$/, '');
  return { digits: digits.length === 0 ? '0' : digits, exponent: Number(exponentText) };
}
