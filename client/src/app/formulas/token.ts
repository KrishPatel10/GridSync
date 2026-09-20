/** Mirrors TokenKind in server/src/GridSync.Core/Formulas/Token.cs. */
export type TokenKind =
  | 'number'
  | 'string'
  /** A1-style cell address such as "B12". */
  | 'cellRef'
  /** A bare word that is not a cell and is not followed by "(", such as "TAX". */
  | 'name'
  /** A word immediately followed by "(", such as "SUM". The "(" is a separate token. */
  | 'function'
  | 'plus'
  | 'minus'
  | 'star'
  | 'slash'
  | 'caret'
  | 'ampersand'
  | 'equal'
  | 'notEqual'
  | 'less'
  | 'lessOrEqual'
  | 'greater'
  | 'greaterOrEqual'
  | 'leftParen'
  | 'rightParen'
  | 'comma'
  | 'colon'
  | 'end';

export interface Token {
  readonly kind: TokenKind;
  /** Source text, except for strings: the contents with the quotes removed and "" collapsed to ". */
  readonly text: string;
  /** Index into the original formula text, for error messages. */
  readonly position: number;
  /** The parsed value; only meaningful for 'number' tokens. */
  readonly number: number;
}

/**
 * The formula text cannot be tokenized or parsed. Thrown (not an error value) because it happens
 * once, when a cell's raw text changes, never during recalculation.
 */
export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'FormulaSyntaxError';
  }
}
