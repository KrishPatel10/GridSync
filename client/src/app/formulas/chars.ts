/**
 * ASCII-only character tests, on purpose. Regex classes like \p{L} and C#'s char.IsLetter accept
 * different Unicode characters, and the two formula engines must never disagree about what a
 * formula means. All of these take a one-character string; charAt() gives '' past the end, and
 * '' fails every test here, so callers never need a bounds check first.
 */
export function isDigit(c: string): boolean {
  return c >= '0' && c <= '9' && c.length === 1;
}

export function isAsciiLetter(c: string): boolean {
  return c.length === 1 && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
}
