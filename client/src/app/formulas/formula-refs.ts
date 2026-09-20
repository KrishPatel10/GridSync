import { CellRef, Expr, RangeRef } from './ast';

export interface FormulaReferences {
  readonly cells: readonly CellRef[];
  readonly ranges: readonly RangeRef[];
}

/**
 * Every cell and range a formula mentions, found by walking the whole tree, including the branch
 * of an IF that will not run. That is deliberate: dependencies are about what a formula *could*
 * read, so the graph never depends on the current values.
 *
 * Uses an explicit stack instead of recursion: the tree can be thousands of nodes deep on the
 * left ("=1+1+1+..."), and this must not overflow.
 */
export function collectReferences(root: Expr): FormulaReferences {
  const cells: CellRef[] = [];
  const ranges: RangeRef[] = [];
  const pending: Expr[] = [root];

  while (pending.length > 0) {
    const node = pending.pop() as Expr;
    switch (node.kind) {
      case 'cell':
        cells.push(node);
        break;
      case 'range':
        ranges.push(node);
        break;
      case 'negate':
        pending.push(node.operand);
        break;
      case 'binary':
        pending.push(node.left, node.right);
        break;
      case 'call':
        for (const arg of node.args) pending.push(arg);
        break;
      default:
        break; // numbers, text and names read no cells
    }
  }

  return { cells, ranges };
}
