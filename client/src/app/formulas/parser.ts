import { BinaryOp, CellRef, Expr } from './ast';
import { tryParseCellAddress } from './cell-ref';
import { FormulaSyntaxError, Token, TokenKind } from './token';
import { tokenize } from './tokenizer';

/**
 * Turns tokens into an AST with a Pratt (precedence-climbing) parser. Mirrors FormulaParser.cs;
 * read the long comment there for the idea. In short: every infix operator has a binding power,
 * and parseExpression(minPower) keeps absorbing operators while they bind tighter than minPower.
 *
 * Precedence follows Excel, lowest to highest: comparisons, &, + -, * /, ^, unary minus. Two Excel
 * quirks are deliberate and pinned by the shared vectors: unary minus binds tighter than ^ (so
 * -2^2 is 4), and ^ is left-associative (so 2^3^2 is 64).
 */

/**
 * How many parse calls may be open at once. The C# parser needs this because a stack overflow
 * kills the .NET process; here it is kept for parity, so both engines accept and reject exactly
 * the same formulas. (JavaScript would throw a catchable RangeError instead, but at a depth that
 * varies by browser, which would break "same input, same result" between engines.)
 */
export const MAX_DEPTH = 64;

const COMPARISON_POWER = 10;
const CONCAT_POWER = 20;
const ADDITIVE_POWER = 30;
const MULTIPLICATIVE_POWER = 40;
const EXPONENT_POWER = 50;
const UNARY_POWER = 60;

/**
 * @param formula raw cell text, including the leading "="
 * @throws FormulaSyntaxError when the text is not a valid formula
 */
export function parseFormula(formula: string): Expr {
  if (formula.length === 0 || formula.charAt(0) !== '=') {
    throw new FormulaSyntaxError("A formula must start with '='", 0);
  }
  return new ParserState(tokenize(formula, 1)).parseAll();
}

const INFIX: Partial<Record<TokenKind, { op: BinaryOp; power: number }>> = {
  equal: { op: 'equal', power: COMPARISON_POWER },
  notEqual: { op: 'notEqual', power: COMPARISON_POWER },
  less: { op: 'less', power: COMPARISON_POWER },
  lessOrEqual: { op: 'lessOrEqual', power: COMPARISON_POWER },
  greater: { op: 'greater', power: COMPARISON_POWER },
  greaterOrEqual: { op: 'greaterOrEqual', power: COMPARISON_POWER },
  ampersand: { op: 'concat', power: CONCAT_POWER },
  plus: { op: 'add', power: ADDITIVE_POWER },
  minus: { op: 'subtract', power: ADDITIVE_POWER },
  star: { op: 'multiply', power: MULTIPLICATIVE_POWER },
  slash: { op: 'divide', power: MULTIPLICATIVE_POWER },
  caret: { op: 'power', power: EXPONENT_POWER },
};

class ParserState {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  private get peek(): Token {
    return this.tokens[this.pos];
  }

  /** Consumes and returns the next token. The 'end' token is never consumed. */
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token.kind !== 'end') this.pos++;
    return token;
  }

  parseAll(): Expr {
    const expr = this.parseExpression(0);
    if (this.peek.kind !== 'end') throw unexpected(this.peek);
    return expr;
  }

  private parseExpression(minPower: number): Expr {
    if (++this.depth > MAX_DEPTH) {
      throw new FormulaSyntaxError('Formula is nested too deeply', this.peek.position);
    }

    let left = this.parsePrefix();

    // "power <= minPower" stops on equal power, which is what makes 1-2-3 group as (1-2)-3.
    // Left-associative chains also run in this loop instead of recursing, so a long
    // "1+1+1+..." does not consume stack.
    for (;;) {
      const infix = INFIX[this.peek.kind];
      if (!infix || infix.power <= minPower) break;

      this.next();
      const right = this.parseExpression(infix.power);
      left = { kind: 'binary', op: infix.op, left, right };
    }

    this.depth--;
    return left;
  }

  /**
   * Anything that can start an expression. The same "-" token is unary here (start of an
   * expression) and binary in the loop above (after a complete operand): position, not the
   * token, decides which one it is.
   */
  private parsePrefix(): Expr {
    const token = this.next();
    switch (token.kind) {
      case 'number':
        return { kind: 'number', value: token.number };

      case 'string':
        return { kind: 'string', value: token.text };

      case 'cellRef':
        return this.parseCellOrRange(token);

      case 'name':
        return { kind: 'name', name: token.text.toUpperCase() };

      case 'function':
        return this.parseCall(token);

      case 'minus':
        // Operand at UNARY_POWER: it swallows nothing but a single operand, so "-2^2" parses as
        // (-2)^2 and "2^-1" still works (the "-" starts the right side of "^").
        return { kind: 'negate', operand: this.parseExpression(UNARY_POWER) };

      case 'leftParen': {
        const inner = this.parseExpression(0);
        if (this.peek.kind !== 'rightParen') throw new FormulaSyntaxError("Expected ')'", this.peek.position);
        this.next();
        return inner;
      }

      default:
        throw unexpected(token);
    }
  }

  /**
   * The ":" is handled here instead of as an operator: a range is only ever cell:cell, so "A1:5"
   * or "SUM(1):B2" are syntax errors and never reach the evaluator.
   */
  private parseCellOrRange(first: Token): Expr {
    const start = toCellRef(first);
    if (this.peek.kind !== 'colon') return start;

    this.next();
    const second = this.next();
    if (second.kind !== 'cellRef') {
      throw new FormulaSyntaxError('Expected a cell address after ":"', second.position);
    }

    const end = toCellRef(second);
    return {
      kind: 'range',
      topLeft: { kind: 'cell', row: Math.min(start.row, end.row), col: Math.min(start.col, end.col) },
      bottomRight: { kind: 'cell', row: Math.max(start.row, end.row), col: Math.max(start.col, end.col) },
    };
  }

  private parseCall(name: Token): Expr {
    this.next(); // the "(" the tokenizer saw right after the name
    const args: Expr[] = [];

    if (this.peek.kind !== 'rightParen') {
      args.push(this.parseExpression(0));
      while (this.peek.kind === 'comma') {
        this.next();
        args.push(this.parseExpression(0));
      }
    }

    if (this.peek.kind !== 'rightParen') throw new FormulaSyntaxError("Expected ',' or ')'", this.peek.position);
    this.next();

    return { kind: 'call', name: name.text.toUpperCase(), args };
  }
}

function toCellRef(token: Token): CellRef {
  const position = tryParseCellAddress(token.text);
  if (!position) throw new FormulaSyntaxError('Invalid cell address', token.position); // the tokenizer already validated it
  return { kind: 'cell', row: position.row, col: position.col };
}

function unexpected(token: Token): FormulaSyntaxError {
  return token.kind === 'end'
    ? new FormulaSyntaxError('Formula ended unexpectedly', token.position)
    : new FormulaSyntaxError(`Unexpected '${token.text}'`, token.position);
}
