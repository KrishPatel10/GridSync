import { decompose } from './number-text';

/**
 * ROUND that behaves like Excel: halves round away from zero, and it rounds what the number looks
 * like (2.675 is 2.68), not what the binary double really holds (2.67499999999999982...).
 * Mirrors DecimalRound.cs.
 *
 * JavaScript has no matching built-in: Math.round rounds halves toward +Infinity (so -2.5 gives
 * -2), and toFixed works on the binary value. So rounding is done on the 15-digit decimal text,
 * which both engines produce identically, and the result is parsed back to a number.
 */
export function decimalRound(value: number, digitsAfterPoint: number): number {
  if (value === 0) return 0;

  const { digits, exponent } = decompose(Math.abs(value));

  // How many leading digits survive. 123.456 rounded to 1 place: exponent 2, so 2+1+1 = 4 digits
  // ("1234"), and the next digit ("5") decides whether to round up.
  let keep = exponent + 1 + digitsAfterPoint;
  if (keep < 0) return 0; // smaller than half a unit: rounds to zero

  let kept: string;
  if (keep >= digits.length) {
    // Nothing lies beyond the requested place, but the result is still the cleaned-up 15-digit
    // number, so ROUND(0.1+0.2, 1) is exactly 0.3 and not 0.30000000000000004.
    kept = digits;
    keep = digits.length;
  } else {
    const roundUp = digits.charAt(keep) >= '5';
    kept = roundUp ? increment(digits.substring(0, keep)) : digits.substring(0, keep);
    if (kept.length === 0) return 0;
  }

  // kept is an integer scaled by 10^(exponent + 1 - keep), e.g. "268" and -2 make 2.68.
  const rounded = Number(`${kept}E${exponent + 1 - keep}`);
  return value < 0 ? -rounded : rounded;
}

/** Adds one to a string of digits: "129" becomes "130", "99" becomes "100", "" becomes "1". */
function increment(digits: string): string {
  const chars = digits.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== '9') {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[i] = '0';
  }
  return '1' + chars.join('');
}
