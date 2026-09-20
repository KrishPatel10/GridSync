import { evaluateExpr, evaluateFormula } from './formula-evaluator';
import { errorValue, numberValue } from './formula-value';
import { MAX_DEPTH, parseFormula } from './parser';
import { TestCells } from './testing/test-cells';

/**
 * Things a shared JSON vector cannot express: how much work the evaluator does, how deep it
 * recurses, and which cells it touches. The values themselves are covered by the vectors. Mirrors
 * FormulaEvaluatorTests.cs.
 */
const evaluate = (formula: string, cells = new TestCells()) => evaluateFormula(formula, cells);

describe('evaluateFormula', () => {
  it('does not recurse per term on a very long chain of additions', () => {
    // 4,000 terms is 8,000 characters, inside the 10,000 character cell limit. The parser builds
    // a tree 4,000 levels deep on the left; the evaluator must walk it with a loop.
    const formula = '=' + Array(4_000).fill('1').join('+');
    expect(evaluate(formula)).toEqual(numberValue(4_000));
  });

  it('keeps the right order in a long chain of mixed operators', () => {
    // 1-1+1-1+... : strictly left to right, so the total alternates 0, 1, 0, 1...
    let formula = '=0';
    for (let i = 0; i < 3_001; i++) formula += (i % 2 === 0 ? '+' : '-') + '1';
    expect(evaluate(formula)).toEqual(numberValue(1));
  });

  it('stops a long chain at the first error and reads no further cells', () => {
    const cells = new TestCells();
    const formula = '=1/0' + '+A1'.repeat(2_000);

    expect(evaluate(formula, cells)).toEqual(errorValue('#DIV/0!'));
    expect(cells.reads).toBe(0);
  });

  it('reads only the cells of the IF branch it takes', () => {
    const cells = new TestCells().raw('A1', '1').raw('B1', '2');
    expect(evaluate('=IF(TRUE,A1,B1)', cells)).toEqual(numberValue(1));
    expect(cells.reads).toBe(1);
  });

  it('reads no cells for an unknown function', () => {
    const cells = new TestCells().raw('A1', '1');
    expect(evaluate('=FOO(A1)', cells)).toEqual(errorValue('#NAME?'));
    expect(cells.reads).toBe(0);
  });

  it('reports the first error in a range in row-major order', () => {
    // B1 is before A2 when reading row by row, so its error is the one reported.
    const cells = new TestCells().value('A2', errorValue('#NAME?')).value('B1', errorValue('#DIV/0!'));
    expect(evaluate('=SUM(A1:B2)', cells)).toEqual(errorValue('#DIV/0!'));
  });

  it('still evaluates nested functions at the parser depth limit', () => {
    // Each SUM( nests one parse level, and the outermost expression takes one itself.
    const depth = MAX_DEPTH - 1;
    const formula = '=' + 'SUM('.repeat(depth) + '1' + ')'.repeat(depth);
    expect(evaluate(formula)).toEqual(numberValue(1));
  });

  it('gives the same answer for an already parsed tree', () => {
    const cells = new TestCells().raw('A1', '4');
    const ast = parseFormula('=A1*A1+1');

    expect(evaluateExpr(ast, cells)).toEqual(evaluateFormula('=A1*A1+1', cells));
    expect(evaluateExpr(ast, cells)).toEqual(numberValue(17));
  });

  it('bounds references by the sheet it was given, not a fixed size', () => {
    const small = new TestCells({ rows: 10, cols: 3 });

    expect(evaluateFormula('=D1', small)).toEqual(errorValue('#REF!'));
    expect(evaluateFormula('=A11', small)).toEqual(errorValue('#REF!'));
    expect(evaluateFormula('=C10', small)).toEqual(numberValue(0));
  });
});
