/**
 * The tree a formula parses into, mirrored from Ast.cs. "=1+2*3" becomes
 * binary(add, 1, binary(multiply, 2, 3)): the shape of the tree is the precedence, so the
 * evaluator never has to think about it.
 */
export type Expr =
  | NumberLiteral
  | StringLiteral
  | CellRef
  | RangeRef
  | NameRef
  | Negate
  | BinaryExpr
  | FunctionCall;

export interface NumberLiteral {
  readonly kind: 'number';
  readonly value: number;
}

export interface StringLiteral {
  readonly kind: 'string';
  readonly value: string;
}

/** Zero-based, matching the (row, col) used by CellOp and cellKey. */
export interface CellRef {
  readonly kind: 'cell';
  readonly row: number;
  readonly col: number;
}

/** Always normalized: topLeft has the smaller row and column, so "B2:A1" is "A1:B2". */
export interface RangeRef {
  readonly kind: 'range';
  readonly topLeft: CellRef;
  readonly bottomRight: CellRef;
}

/**
 * A bare word like "TAX". The parser accepts it and the evaluator turns it into #NAME?, so a
 * formula with a typo still parses and shows an error instead of being unparseable.
 */
export interface NameRef {
  readonly kind: 'name';
  readonly name: string;
}

export interface Negate {
  readonly kind: 'negate';
  readonly operand: Expr;
}

export type BinaryOp =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'power'
  | 'concat'
  | 'equal'
  | 'notEqual'
  | 'less'
  | 'lessOrEqual'
  | 'greater'
  | 'greaterOrEqual';

export interface BinaryExpr {
  readonly kind: 'binary';
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
}

/**
 * name is upper-cased. The parser does not know which functions exist; an unknown one becomes
 * #NAME? at evaluation time, which keeps the parser independent of the function library.
 */
export interface FunctionCall {
  readonly kind: 'call';
  readonly name: string;
  readonly args: readonly Expr[];
}
