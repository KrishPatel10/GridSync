import { MAX_DEPTH, parseFormula } from './parser';
import { FormulaSyntaxError } from './token';
import { dump } from './testing/expr-dump';

const tree = (formula: string): string => dump(parseFormula(formula));

const positionOfError = (formula: string): number => {
  try {
    parseFormula(formula);
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return error.position;
    throw error;
  }
  throw new Error(`expected "${formula}" to be rejected`);
};

describe('parseFormula', () => {
  it.each([
    ['=42', '42'],
    ['="hi"', '"hi"'],
    ['=A1', 'A1'],
    ['=(A1)', 'A1'],
    ['=TAX', 'name:TAX'],
    ['=tax', 'name:TAX'],
  ])('parses the atom %s', (formula, expected) => {
    expect(tree(formula)).toBe(expected);
  });

  it.each([
    ['=1+2*3', '(1 + (2 * 3))'],
    ['=1*2+3', '((1 * 2) + 3)'],
    ['=(1+2)*3', '((1 + 2) * 3)'],
    ['=1+2+3', '((1 + 2) + 3)'],
    ['=1-2-3', '((1 - 2) - 3)'],
    ['=8/4/2', '((8 / 4) / 2)'],
    ['=2*3^2', '(2 * (3 ^ 2))'],
  ])('applies arithmetic precedence and left associativity: %s', (formula, expected) => {
    expect(tree(formula)).toBe(expected);
  });

  it.each([
    ['=-2^2', '((-2) ^ 2)'], // Excel: unary minus binds tighter than ^, so this is 4
    ['=2^-1', '(2 ^ (-1))'],
    ['=2^3^2', '((2 ^ 3) ^ 2)'], // Excel: ^ is left-associative, so this is 64
    ['=--5', '(-(-5))'],
    ['=1--1', '(1 - (-1))'],
    ['=-A1*2', '((-A1) * 2)'],
    ['=-(1+2)', '(-(1 + 2))'],
  ])("follows Excel's unary minus and exponent rules: %s", (formula, expected) => {
    expect(tree(formula)).toBe(expected);
  });

  it.each([
    ['="a"&"b"', '("a" & "b")'],
    ['=1&2+3', '(1 & (2 + 3))'], // + binds tighter than &
    ['=1+2=3', '((1 + 2) = 3)'], // comparisons are the loosest
    ['=1&2=12', '((1 & 2) = 12)'],
    ['=A1<>B1', '(A1 <> B1)'],
    ['=A1<=B1', '(A1 <= B1)'],
    ['=1<2<3', '((1 < 2) < 3)'],
  ])('ranks concatenation above comparison and below addition: %s', (formula, expected) => {
    expect(tree(formula)).toBe(expected);
  });

  it.each([
    ['=A1:B2', 'A1:B2'],
    ['=B2:A1', 'A1:B2'], // normalized so the evaluator never has to care
    ['=B1:A2', 'A1:B2'],
    ['=A1:A1', 'A1:A1'],
    ['=a1:c3', 'A1:C3'],
  ])('parses and normalizes the range %s', (formula, expected) => {
    expect(tree(formula)).toBe(expected);
  });

  it.each([
    ['=SUM(A1:A3)', 'SUM(A1:A3)'],
    ['=sum(a1:a3)', 'SUM(A1:A3)'],
    ['=SUM(1,2,3)', 'SUM(1, 2, 3)'],
    ['=NOW()', 'NOW()'],
    ['=IF(A1>0,"pos","neg")', 'IF((A1 > 0), "pos", "neg")'],
    ['=ROUND(SUM(A1:A3)/3,2)', 'ROUND((SUM(A1:A3) / 3), 2)'],
    ['=1+SUM(2,3)*4', '(1 + (SUM(2, 3) * 4))'],
    ['=NOSUCHFN(1)', 'NOSUCHFN(1)'], // unknown functions parse; the evaluator gives #NAME?
  ])('parses the function call %s', (formula, expected) => {
    expect(tree(formula)).toBe(expected);
  });

  it('ignores whitespace between tokens', () => {
    expect(tree('= 1 +\t2 *  A1 ')).toBe('(1 + (2 * A1))');
  });

  it.each([
    ['', 0], // no "="
    ['1+2', 0], // no "="
    ['=', 1], // nothing after it
    ['=1+', 3], // dangling operator
    ['=*2', 1], // operator with no left side
    ['=(1', 3], // unclosed paren: reported at the end of the text
    ['=1)', 2], // stray closing paren
    ['=1 2', 3], // two operands in a row
    ['=A1 B1', 4],
    ['=SUM(1,)', 7], // trailing comma
    ['=SUM(,1)', 5], // leading comma
    ['=SUM(1 2)', 7], // missing comma
    ['=SUM(1', 6], // unclosed call
    ['=A1:5', 4], // a range needs a cell on both sides
    ['=A1:', 4],
    ['=1:B2', 2], // ":" is only valid between two cells
    ['=A1:B2:C3', 6], // no chained ranges: the second ":" is the problem
    ['="open', 1], // tokenizer error surfaces too
    ['=1 $ 2', 3],
  ])('rejects the malformed formula %j and says where (%i)', (formula, position) => {
    expect(positionOfError(formula)).toBe(position);
  });

  it('allows nesting up to the limit', () => {
    const depth = MAX_DEPTH - 1; // the outermost expression uses one level itself
    expect(tree('=' + '('.repeat(depth) + '1' + ')'.repeat(depth))).toBe('1');
  });

  it('rejects nesting past the limit', () => {
    const depth = MAX_DEPTH;
    expect(() => parseFormula('=' + '('.repeat(depth) + '1' + ')'.repeat(depth))).toThrow(FormulaSyntaxError);
  });

  it('fails cleanly on deeply nested input', () => {
    // Same input as the C# test that guards against a process-ending stack overflow. Here the
    // point is that both engines reject the same formulas, at the same depth.
    expect(() => parseFormula('=' + '('.repeat(4_999) + '1' + ')'.repeat(4_999))).toThrow(FormulaSyntaxError);
  });

  it('depth-limits a long run of unary minus too', () => {
    expect(() => parseFormula('=' + '-'.repeat(5_000) + '1')).toThrow(FormulaSyntaxError);
  });

  it('parses long left-associative chains without deep recursion', () => {
    // 1+1+1+... is handled by the loop in parseExpression, not by recursion, so it is not
    // subject to MAX_DEPTH.
    const formula = '=' + Array(4_000).fill('1').join('+');
    expect(parseFormula(formula).kind).toBe('binary');
  });
});
