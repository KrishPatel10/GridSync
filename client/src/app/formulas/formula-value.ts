import { numberToText, tryParseNumber } from './number-text';

/**
 * The error codes as the sheet shows them. Mirrors the FormulaError enum in FormulaValue.cs, which
 * uses these same strings as its display codes.
 */
export type FormulaError =
  | '#DIV/0!'
  | '#VALUE!'
  | '#REF!'
  | '#NAME?'
  /**
   * A result that is not a finite number (overflow, 0^0, a negative number to a fractional
   * power). Without it, Infinity and NaN would leak out and print differently in C# and JS.
   */
  | '#NUM!'
  | '#CYCLE!'
  /** The formula text does not parse. Produced around the evaluator, never by it. */
  | '#ERROR!';

/**
 * What a cell is worth: the result of a formula, or a constant read from raw text. Errors are
 * values, not exceptions, so "=1/0+5" is simply #DIV/0! carried up the tree.
 */
export type FormulaValue =
  /** A cell with nothing in it. Behaves as 0, "" or FALSE depending on context. */
  | { readonly kind: 'empty' }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'error'; readonly error: FormulaError };

export const EMPTY: FormulaValue = { kind: 'empty' };

/**
 * Callers must pass a finite number (the evaluator checks). Negative zero is turned into plain
 * zero here, once, because "-0" would print differently in C# and JavaScript.
 */
export function numberValue(value: number): FormulaValue {
  return { kind: 'number', value: value === 0 ? 0 : value };
}

export function textValue(value: string): FormulaValue {
  return { kind: 'text', value };
}

export function booleanValue(value: boolean): FormulaValue {
  return { kind: 'boolean', value };
}

export function errorValue(error: FormulaError): FormulaValue {
  return { kind: 'error', error };
}

/**
 * How the sheet reads a constant cell: nothing is empty, text that is entirely a number is a
 * number ("5" makes =A1+1 equal 6), everything else is text. Formulas (raw text starting with
 * "=") are not handled here; the caller evaluates those.
 */
export function valueFromRaw(raw: string | null | undefined): FormulaValue {
  if (raw === null || raw === undefined || raw === '') return EMPTY;
  const number = tryParseNumber(raw);
  return number === null ? textValue(raw) : numberValue(number);
}

/** The text a cell shows for this value: "3", "hello", "TRUE", "#DIV/0!". */
export function displayString(value: FormulaValue): string {
  switch (value.kind) {
    case 'empty':
      return '';
    case 'number':
      return numberToText(value.value);
    case 'text':
      return value.value;
    case 'boolean':
      return value.value ? 'TRUE' : 'FALSE';
    case 'error':
      return value.error;
  }
}
