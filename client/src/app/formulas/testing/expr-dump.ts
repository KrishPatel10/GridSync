import { Expr } from '../ast';
import { cellAddress } from '../../grid/cell-address';

/**
 * Test-only. Prints an AST fully parenthesized so tests can assert on shape as a string:
 * "1+2*3" becomes "(1 + (2 * 3))". Same format as AstDump.cs. Only for short expressions.
 */
export function dump(expr: Expr): string {
  switch (expr.kind) {
    case 'number':
      return String(expr.value);
    case 'string':
      return `"${expr.value}"`;
    case 'cell':
      return cellAddress(expr.row, expr.col);
    case 'range':
      return `${dump(expr.topLeft)}:${dump(expr.bottomRight)}`;
    case 'name':
      return `name:${expr.name}`;
    case 'negate':
      return `(-${dump(expr.operand)})`;
    case 'binary':
      return `(${dump(expr.left)} ${SYMBOLS[expr.op]} ${dump(expr.right)})`;
    case 'call':
      return `${expr.name}(${expr.args.map(dump).join(', ')})`;
  }
}

const SYMBOLS = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
  power: '^',
  concat: '&',
  equal: '=',
  notEqual: '<>',
  less: '<',
  lessOrEqual: '<=',
  greater: '>',
  greaterOrEqual: '>=',
} as const;
