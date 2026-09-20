import { BinaryExpr, BinaryOp, CellRef, Expr, FunctionCall, NameRef, Negate, RangeRef } from './ast';
import { CellReader } from './cell-reader';
import { decimalRound } from './decimal-round';
import {
  booleanValue,
  displayString,
  errorValue,
  FormulaError,
  FormulaValue,
  numberValue,
  textValue,
} from './formula-value';
import { tryParseNumber } from './number-text';
import { parseFormula } from './parser';
import { FormulaSyntaxError } from './token';

/**
 * Walks a parsed formula and produces a value. Mirrors FormulaEvaluator.cs rule for rule; every
 * place this deliberately differs from Excel is called out there, and the shared vectors pin all
 * of it so the two engines cannot drift.
 *
 * Errors are values. The first error met (left operand before right, arguments left to right)
 * becomes the result. IF is lazy: only the chosen branch is evaluated.
 */

/** Full pipeline for raw cell text that starts with "=". */
export function evaluateFormula(formula: string, cells: CellReader): FormulaValue {
  let ast: Expr;
  try {
    ast = parseFormula(formula);
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return errorValue('#ERROR!');
    throw error;
  }
  return evaluateExpr(ast, cells);
}

/**
 * For callers that parse once and evaluate many times (the dependency graph). An empty result is
 * shown as 0, like "=A1" does in Excel when A1 is blank.
 */
export function evaluateExpr(expr: Expr, cells: CellReader): FormulaValue {
  const value = evalNode(expr, cells);
  return value.kind === 'empty' ? numberValue(0) : value;
}

function evalNode(expr: Expr, cells: CellReader): FormulaValue {
  switch (expr.kind) {
    case 'number':
      return numberValue(expr.value);
    case 'string':
      return textValue(expr.value);
    case 'cell':
      return readCell(expr, cells);
    case 'range':
      // A range only means something as a function argument (SUM(A1:A3)). Anywhere else, like
      // "=A1:A3+1", it would need array behaviour we do not have.
      return fail('#VALUE!');
    case 'name':
      return evalName(expr);
    case 'negate':
      return evalNegate(expr, cells);
    case 'binary':
      return evalBinary(expr, cells);
    case 'call':
      return evalCall(expr, cells);
  }
}

function fail(error: FormulaError): FormulaValue {
  return errorValue(error);
}

function finite(value: number): FormulaValue {
  return Number.isFinite(value) ? numberValue(value) : fail('#NUM!');
}

function inSheet(cell: CellRef, cells: CellReader): boolean {
  return cell.row < cells.dimensions.rows && cell.col < cells.dimensions.cols;
}

function readCell(cell: CellRef, cells: CellReader): FormulaValue {
  return inSheet(cell, cells) ? cells.getValue(cell.row, cell.col) : fail('#REF!');
}

function evalName(name: NameRef): FormulaValue {
  switch (name.name) {
    case 'TRUE':
      return booleanValue(true);
    case 'FALSE':
      return booleanValue(false);
    default:
      return fail('#NAME?');
  }
}

function evalNegate(negate: Negate, cells: CellReader): FormulaValue {
  const operand = toNumber(evalNode(negate.operand, cells));
  return operand.ok ? numberValue(-operand.number) : operand.error;
}

// ---- Binary operators --------------------------------------------------------------------------

/**
 * "1+2+3+4" parses to a tree that is deep on the left: ((1+2)+3)+4. Recursing down it would use a
 * stack frame per term, and a 10,000-character cell allows thousands of terms. So walk down the
 * left side with a loop, then fold back up. Recursion only happens for right-hand sides, and the
 * parser's nesting limit already bounds that.
 */
function evalBinary(root: BinaryExpr, cells: CellReader): FormulaValue {
  if (root.left.kind !== 'binary') {
    return apply(root.op, evalNode(root.left, cells), root.right, cells);
  }

  const spine: BinaryExpr[] = [];
  let node: Expr = root;
  while (node.kind === 'binary') {
    spine.push(node);
    node = node.left;
  }

  let accumulated = evalNode(node, cells);
  for (let i = spine.length - 1; i >= 0; i--) {
    accumulated = apply(spine[i].op, accumulated, spine[i].right, cells);
  }
  return accumulated;
}

/**
 * Order of checks: left error, right error, then coercion failures. Once the left side is an
 * error the right side is not even evaluated.
 */
function apply(op: BinaryOp, left: FormulaValue, rightExpr: Expr, cells: CellReader): FormulaValue {
  if (left.kind === 'error') return left;
  const right = evalNode(rightExpr, cells);
  if (right.kind === 'error') return right;

  switch (op) {
    case 'concat':
      return textValue(displayString(left) + displayString(right));

    case 'equal':
    case 'notEqual':
    case 'less':
    case 'lessOrEqual':
    case 'greater':
    case 'greaterOrEqual':
      return booleanValue(satisfies(op, compare(left, right)));
  }

  const l = toNumber(left);
  if (!l.ok) return l.error;
  const r = toNumber(right);
  if (!r.ok) return r.error;

  switch (op) {
    case 'add':
      return finite(l.number + r.number);
    case 'subtract':
      return finite(l.number - r.number);
    case 'multiply':
      return finite(l.number * r.number);
    case 'divide':
      return r.number === 0 ? fail('#DIV/0!') : finite(l.number / r.number);
    case 'power':
      return power(l.number, r.number);
  }
}

/**
 * Excel: 0^0 is #NUM! (not 1) and 0^-1 is #DIV/0!. Math.pow is used for everything else. It is
 * the one place where C# and JS may differ in the last digit for non-integer exponents, so the
 * vectors stick to results that are exact.
 */
function power(base: number, exponent: number): FormulaValue {
  if (base === 0 && exponent === 0) return fail('#NUM!');
  if (base === 0 && exponent < 0) return fail('#DIV/0!');
  return finite(Math.pow(base, exponent));
}

function satisfies(op: BinaryOp, comparison: number): boolean {
  switch (op) {
    case 'equal':
      return comparison === 0;
    case 'notEqual':
      return comparison !== 0;
    case 'less':
      return comparison < 0;
    case 'lessOrEqual':
      return comparison <= 0;
    case 'greater':
      return comparison > 0;
    default:
      return comparison >= 0;
  }
}

/**
 * Excel's ordering across types: numbers are below text, text is below booleans. Text ignores
 * ASCII case only: full Unicode case folding differs between .NET and JS ("ß"), and the engines
 * must agree. Comparing exactly on doubles means 0.1+0.2=0.3 is FALSE; Excel quietly forgives
 * that, this engine does not.
 */
function compare(left: FormulaValue, right: FormulaValue): number {
  if (left.kind === 'empty' && right.kind === 'empty') return 0;
  if (left.kind === 'empty') left = blankLike(right);
  if (right.kind === 'empty') right = blankLike(left);

  if (left.kind !== right.kind) return rank(left) < rank(right) ? -1 : 1;

  switch (left.kind) {
    case 'text':
      return compareIgnoringAsciiCase(left.value, (right as typeof left).value);
    case 'boolean':
      return compareNumbers(left.value ? 1 : 0, (right as typeof left).value ? 1 : 0);
    case 'number':
      return compareNumbers(left.value, (right as typeof left).value);
    default:
      return 0; // unreachable: errors are returned before comparing, empties were replaced above
  }
}

/** What an empty cell counts as when compared with something: 0, "" or FALSE. */
function blankLike(other: FormulaValue): FormulaValue {
  switch (other.kind) {
    case 'text':
      return textValue('');
    case 'boolean':
      return booleanValue(false);
    default:
      return numberValue(0);
  }
}

function rank(value: FormulaValue): number {
  switch (value.kind) {
    case 'number':
      return 0;
    case 'text':
      return 1;
    default:
      return 2;
  }
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIgnoringAsciiCase(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = foldAscii(a.charCodeAt(i));
    const y = foldAscii(b.charCodeAt(i));
    if (x !== y) return x < y ? -1 : 1;
  }
  return compareNumbers(a.length, b.length);
}

function foldAscii(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

// ---- Coercions ---------------------------------------------------------------------------------

type NumberResult = { readonly ok: true; readonly number: number } | { readonly ok: false; readonly error: FormulaValue };

/**
 * Number for arithmetic: blank is 0, TRUE is 1, and text works only if the whole text is a number
 * ("5" yes, "hello" no, which is #VALUE!). An error passes straight through.
 */
function toNumber(value: FormulaValue): NumberResult {
  switch (value.kind) {
    case 'empty':
      return { ok: true, number: 0 };
    case 'number':
      return { ok: true, number: value.value };
    case 'boolean':
      return { ok: true, number: value.value ? 1 : 0 };
    case 'text': {
      const parsed = tryParseNumber(value.value);
      return parsed === null ? { ok: false, error: fail('#VALUE!') } : { ok: true, number: parsed };
    }
    case 'error':
      return { ok: false, error: value };
  }
}

type BooleanResult = { readonly ok: true; readonly result: boolean } | { readonly ok: false; readonly error: FormulaValue };

function toBoolean(value: FormulaValue): BooleanResult {
  switch (value.kind) {
    case 'empty':
      return { ok: true, result: false };
    case 'boolean':
      return { ok: true, result: value.value };
    case 'number':
      return { ok: true, result: value.value !== 0 };
    case 'text':
      if (compareIgnoringAsciiCase(value.value, 'TRUE') === 0) return { ok: true, result: true };
      if (compareIgnoringAsciiCase(value.value, 'FALSE') === 0) return { ok: true, result: false };
      return { ok: false, error: fail('#VALUE!') };
    case 'error':
      return { ok: false, error: value };
  }
}

// ---- Functions ---------------------------------------------------------------------------------

function evalCall(call: FunctionCall, cells: CellReader): FormulaValue {
  switch (call.name) {
    case 'SUM':
      return aggregate(call, cells, 'sum');
    case 'AVERAGE':
      return aggregate(call, cells, 'average');
    case 'MIN':
      return aggregate(call, cells, 'min');
    case 'MAX':
      return aggregate(call, cells, 'max');
    case 'COUNT':
      return aggregate(call, cells, 'count');
    case 'IF':
      return evalIf(call, cells);
    case 'ROUND':
      return evalRound(call, cells);
    default:
      return fail('#NAME?');
  }
}

function evalIf(call: FunctionCall, cells: CellReader): FormulaValue {
  if (call.args.length < 2 || call.args.length > 3) return fail('#VALUE!');

  const condition = toBoolean(evalNode(call.args[0], cells));
  if (!condition.ok) return condition.error;
  if (condition.result) return evalNode(call.args[1], cells);
  return call.args.length === 3 ? evalNode(call.args[2], cells) : booleanValue(false);
}

function evalRound(call: FunctionCall, cells: CellReader): FormulaValue {
  if (call.args.length !== 2) return fail('#VALUE!');

  const number = toNumber(evalNode(call.args[0], cells));
  if (!number.ok) return number.error;
  const places = toNumber(evalNode(call.args[1], cells));
  if (!places.ok) return places.error;

  // Excel drops the fraction of the digit count. The clamp keeps the value sane; nothing real
  // needs more than a few hundred places.
  const digits = Math.min(Math.max(Math.trunc(places.number), -1000), 1000);
  return finite(decimalRound(number.number, digits));
}

type Aggregation = 'sum' | 'average' | 'min' | 'max' | 'count';

interface Totals {
  sum: number;
  count: number;
  min: number;
  max: number;
}

function addNumber(totals: Totals, value: number): void {
  if (totals.count === 0 || value < totals.min) totals.min = value;
  if (totals.count === 0 || value > totals.max) totals.max = value;
  totals.sum += value;
  totals.count++;
}

/**
 * SUM, AVERAGE, MIN, MAX and COUNT share one rule about what counts, which is Excel's:
 * - A cell or range reference contributes only its numbers. Text, booleans and blanks in it are
 *   skipped, so SUM(A1:A9) survives a header row.
 * - Anything else typed as an argument (SUM(1, "2", TRUE, A1+1)) is coerced like arithmetic.
 * - An error stops everything and becomes the result, except in COUNT, which ignores errors.
 * Cells are read row by row, left to right: floating-point addition is not associative, so the
 * order is part of the spec.
 */
function aggregate(call: FunctionCall, cells: CellReader, kind: Aggregation): FormulaValue {
  if (call.args.length === 0) return fail('#VALUE!');

  const ignoreErrors = kind === 'count';
  const totals: Totals = { sum: 0, count: 0, min: 0, max: 0 };

  for (const arg of call.args) {
    let failure: FormulaValue | null;
    if (arg.kind === 'range') {
      failure = addRange(arg, cells, totals, ignoreErrors);
    } else if (arg.kind === 'cell') {
      failure = addRange({ kind: 'range', topLeft: arg, bottomRight: arg }, cells, totals, ignoreErrors);
    } else {
      failure = addValue(evalNode(arg, cells), totals, ignoreErrors);
    }
    if (failure) return failure;
  }

  switch (kind) {
    case 'sum':
      return finite(totals.sum);
    case 'average':
      return totals.count === 0 ? fail('#DIV/0!') : finite(totals.sum / totals.count);
    case 'min':
      return numberValue(totals.count === 0 ? 0 : totals.min);
    case 'max':
      return numberValue(totals.count === 0 ? 0 : totals.max);
    case 'count':
      return numberValue(totals.count);
  }
}

function addRange(range: RangeRef, cells: CellReader, totals: Totals, ignoreErrors: boolean): FormulaValue | null {
  if (!inSheet(range.bottomRight, cells)) return fail('#REF!');

  for (let row = range.topLeft.row; row <= range.bottomRight.row; row++) {
    for (let col = range.topLeft.col; col <= range.bottomRight.col; col++) {
      const value = cells.getValue(row, col);
      if (value.kind === 'number') addNumber(totals, value.value);
      else if (value.kind === 'error' && !ignoreErrors) return value;
    }
  }
  return null;
}

function addValue(value: FormulaValue, totals: Totals, ignoreErrors: boolean): FormulaValue | null {
  if (value.kind === 'error') return ignoreErrors ? null : value;

  const number = toNumber(value);
  if (number.ok) {
    addNumber(totals, number.number);
    return null;
  }

  // Text that is not a number: skipped by COUNT, #VALUE! for everything else.
  return ignoreErrors ? null : fail('#VALUE!');
}
