import { FormulaSyntaxError, Token } from './token';
import { tokenize } from './tokenizer';

/** Token kinds joined by spaces, without the trailing end token. */
const kinds = (source: string, start = 0): string =>
  tokenize(source, start)
    .slice(0, -1)
    .map((t) => t.kind)
    .join(' ');

const single = (source: string): Token => {
  const tokens = tokenize(source);
  expect(tokens.length).toBe(2); // the token plus end
  return tokens[0];
};

const positionOfError = (source: string): number => {
  try {
    tokenize(source);
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return error.position;
    throw error;
  }
  throw new Error(`expected "${source}" to be rejected`);
};

describe('tokenize', () => {
  it('splits a realistic formula', () => {
    expect(kinds('SUM(A1:A3)*2+B1')).toBe('function leftParen cellRef colon cellRef rightParen star number plus cellRef');
  });

  it('always ends with an end token at the end of the text', () => {
    const tokens = tokenize('1 + 2');
    expect(tokens[tokens.length - 1]).toMatchObject({ kind: 'end', position: 5 });
  });

  it('can start after the leading equals sign', () => {
    const tokens = tokenize('=A1', 1);
    expect(tokens[0]).toMatchObject({ kind: 'cellRef', position: 1 }); // positions still point into the original text
  });

  it.each([
    ['12', 12],
    ['3.14', 3.14],
    ['.5', 0.5],
    ['1.', 1],
    ['1e3', 1000],
    ['2.5E-2', 0.025],
    ['1E+2', 100],
  ])('reads the number %s', (text, expected) => {
    expect(single(text)).toMatchObject({ kind: 'number', number: expected });
  });

  it('does not treat an e without digits as an exponent', () => {
    // "2e" is the number 2 followed by the name "e"; the parser will reject the pair.
    expect(kinds('2e')).toBe('number name');
  });

  it('leaves the minus sign out of numbers', () => {
    expect(kinds('-5')).toBe('minus number');
  });

  it('rejects numbers too big for a double', () => {
    expect(positionOfError('1e999')).toBe(0);
  });

  it.each([
    ['"hello"', 'hello'],
    ['""', ''],
    ['"say ""hi"""', 'say "hi"'],
    ['"a + b"', 'a + b'],
  ])('reads the string %s and unescapes doubled quotes', (source, expected) => {
    expect(single(source)).toMatchObject({ kind: 'string', text: expected });
  });

  it('reports where an unterminated string started', () => {
    expect(positionOfError('1&"oops')).toBe(2);
  });

  it.each([
    ['A1', 'cellRef'],
    ['aa10', 'cellRef'],
    ['XFD1', 'cellRef'],
    ['A0', 'name'], // rows start at 1
    ['ABCD1', 'name'], // columns are at most 3 letters
    ['TAX', 'name'],
    ['_x', 'name'],
    ['SUM(', 'function'],
    ['sum(', 'function'],
    ['LOG10(', 'function'], // looks like a cell, but the "(" wins
  ])('classifies the word %s as %s', (source, expected) => {
    expect(tokenize(source)[0].kind).toBe(expected);
  });

  it('treats a space before the paren as not a function call', () => {
    expect(kinds('SUM (')).toBe('name leftParen');
  });

  it('keeps the original case of words', () => {
    expect(single('aa10').text).toBe('aa10');
  });

  it('reads every operator including two-character ones', () => {
    expect(kinds('+ - * / ^ & = <> < <= > >= ( ) , :')).toBe(
      'plus minus star slash caret ampersand equal notEqual less lessOrEqual greater greaterOrEqual leftParen rightParen comma colon',
    );
  });

  it('needs no spaces around two-character operators', () => {
    expect(kinds('A1<=B1<>C1')).toBe('cellRef lessOrEqual cellRef notEqual cellRef');
  });

  it('skips spaces, tabs and newlines', () => {
    expect(kinds(' 1\t+\r\n 2 ')).toBe('number plus number');
  });

  it.each([
    ['1 + $A$1', 4], // absolute references are not supported yet
    ['1 ! 2', 2],
    ['1 + 2', 1], // non-breaking space: only plain whitespace is skipped
  ])('rejects unexpected characters in %j at their position', (source, position) => {
    expect(positionOfError(source)).toBe(position);
  });
});
