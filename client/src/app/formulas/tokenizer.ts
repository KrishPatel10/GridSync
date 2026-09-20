import { isAsciiLetter, isDigit } from './chars';
import { tryParseCellAddress } from './cell-ref';
import { FormulaSyntaxError, Token, TokenKind } from './token';

/**
 * Step one of reading a formula: chop the text into tokens ("=SUM(A1:A3)*2" becomes SUM ( A1 : A3
 * ) * 2). It knows nothing about precedence or nesting; that is the parser's job. Mirrors
 * Tokenizer.cs rule for rule: ASCII only, hand-rolled, no regex.
 *
 * @param source the whole raw cell text, including the leading "="
 * @param start where to begin; the parser passes 1 to skip the "="
 * @returns tokens followed by one 'end' token
 */
export function tokenize(source: string, start = 0): Token[] {
  const tokens: Token[] = [];
  let i = start;

  while (i < source.length) {
    const c = source.charAt(i);

    if (isWhitespace(c)) {
      i++;
    } else if (isDigit(c) || (c === '.' && isDigit(source.charAt(i + 1)))) {
      i = readNumber(source, i, tokens);
    } else if (c === '"') {
      i = readString(source, i, tokens);
    } else if (isAsciiLetter(c) || c === '_') {
      i = readWord(source, i, tokens);
    } else {
      i = readOperator(source, i, tokens);
    }
  }

  tokens.push({ kind: 'end', text: '', position: source.length, number: 0 });
  return tokens;
}

function readNumber(s: string, begin: number, tokens: Token[]): number {
  let i = begin;
  while (isDigit(s.charAt(i))) i++;

  if (s.charAt(i) === '.') {
    i++;
    while (isDigit(s.charAt(i))) i++;
  }

  // Only treat "e" as an exponent when digits follow ("1e3", "2.5E-2"). Otherwise it starts a
  // new token and the parser reports the stray word.
  if (s.charAt(i) === 'e' || s.charAt(i) === 'E') {
    let j = i + 1;
    if (s.charAt(j) === '+' || s.charAt(j) === '-') j++;
    if (isDigit(s.charAt(j))) {
      while (isDigit(s.charAt(j))) j++;
      i = j;
    }
  }

  const text = s.substring(begin, i);
  const value = Number(text); // the text is already validated as digits, ".", "e" and a sign
  if (!Number.isFinite(value)) throw new FormulaSyntaxError(`Number '${text}' is out of range`, begin);

  tokens.push({ kind: 'number', text, position: begin, number: value });
  return i;
}

/** Excel-style: a literal quote inside a string is written as two quotes. */
function readString(s: string, begin: number, tokens: Token[]): number {
  let text = '';
  let i = begin + 1;

  for (;;) {
    if (i >= s.length) throw new FormulaSyntaxError('Text is missing its closing quote', begin);

    const c = s.charAt(i++);
    if (c !== '"') {
      text += c;
    } else if (s.charAt(i) === '"') {
      text += '"';
      i++;
    } else {
      break;
    }
  }

  tokens.push({ kind: 'string', text, position: begin, number: 0 });
  return i;
}

/**
 * One word, three meanings. "SUM(" is a function, "A1" is a cell, anything else is a name. The
 * "(" lookahead is what lets "LOG10(" be a function even though "LOG10" also looks like a cell
 * (column LOG, row 10). Excel resolves it the same way.
 */
function readWord(s: string, begin: number, tokens: Token[]): number {
  let i = begin;
  while (isAsciiLetter(s.charAt(i)) || isDigit(s.charAt(i)) || s.charAt(i) === '_') i++;

  const text = s.substring(begin, i);
  const kind: TokenKind =
    s.charAt(i) === '(' ? 'function' : tryParseCellAddress(text) !== null ? 'cellRef' : 'name';

  tokens.push({ kind, text, position: begin, number: 0 });
  return i;
}

function readOperator(s: string, i: number, tokens: Token[]): number {
  const c = s.charAt(i);
  const next = s.charAt(i + 1);

  let kind: TokenKind;
  let length = 1;
  switch (c) {
    case '+': kind = 'plus'; break;
    case '-': kind = 'minus'; break;
    case '*': kind = 'star'; break;
    case '/': kind = 'slash'; break;
    case '^': kind = 'caret'; break;
    case '&': kind = 'ampersand'; break;
    case '=': kind = 'equal'; break;
    case '(': kind = 'leftParen'; break;
    case ')': kind = 'rightParen'; break;
    case ',': kind = 'comma'; break;
    case ':': kind = 'colon'; break;
    case '<':
      if (next === '=') { kind = 'lessOrEqual'; length = 2; }
      else if (next === '>') { kind = 'notEqual'; length = 2; }
      else kind = 'less';
      break;
    case '>':
      if (next === '=') { kind = 'greaterOrEqual'; length = 2; }
      else kind = 'greater';
      break;
    default:
      throw new FormulaSyntaxError(`Unexpected character '${c}'`, i);
  }

  tokens.push({ kind, text: s.substring(i, i + length), position: i, number: 0 });
  return i + length;
}

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n';
}
