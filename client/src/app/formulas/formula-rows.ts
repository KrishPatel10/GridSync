import { RowOrder } from '../rows/row-order';
import { tryParseCellAddress } from './cell-ref';
import { tokenize } from './tokenizer';
import { FormulaSyntaxError, Token } from './token';

/**
 * Formulas name cells by row *number* when you type them ("=A5+B7") but must follow the row when
 * someone inserts a row above it. So the text that is stored and synced names rows by their stable
 * id instead: "=A_b4+B_b6", where "b4" is the id of the fifth initial row. What you see and edit is
 * always the numbered form; these two functions convert at the edges, using the current row order.
 *
 * Why it works: inserting a row changes which number a row has, never its id, so the stored text of
 * every existing formula is untouched by an insert, and every replica, which agrees on the row
 * order, reads it back as the same numbers. A range "A_x:A_y" is two ids, so it grows when a row is
 * inserted between them, as in Excel.
 *
 * The stored form is one "word" to the tokenizer (letters, digits and underscores), so it is found
 * by tokenizing rather than by scanning the text, which keeps "A1" inside a string ("see A1") alone.
 *
 * Limits, both on purpose: text that does not tokenize (an unterminated string) is left exactly as
 * typed, since it is #ERROR! whichever form it is in; and a reference beyond the last row stays as
 * typed, since it is #REF! and there is no row to name.
 */
const STORED_REF = /^([A-Za-z]{1,3})_(b(?:0|[1-9]\d{0,8})|[0-9a-f]{32})$/;

/** "=A5+B7" as typed becomes the form that is stored and synced. Anything that is not a formula is returned as is. */
export function toStoredFormula(text: string, order: RowOrder): string {
  return rewrite(text, (token) => {
    if (token.kind !== 'cellRef') return null;
    const at = tryParseCellAddress(token.text);
    const rowId = at === null ? undefined : order.idAt(at.row);
    if (at === null || rowId === undefined) return null; // beyond the sheet: nothing to follow
    return `${token.text.substring(0, token.text.search(/\d/))}_${rowId}`;
  });
}

/** The stored form back into numbers, using the rows as they are now. */
export function toDisplayFormula(text: string, order: RowOrder): string {
  return rewrite(text, (token) => {
    if (token.kind !== 'name') return null;
    const match = STORED_REF.exec(token.text);
    if (!match) return null;
    const index = order.indexOf(match[2]);
    // A row this replica has not heard of yet reads as one past the end, so it is #REF! until it arrives.
    return `${match[1]}${(index >= 0 ? index : order.count) + 1}`;
  });
}

function rewrite(text: string, replace: (token: Token) => string | null): string {
  if (text.charAt(0) !== '=') return text;

  let tokens: Token[];
  try {
    tokens = tokenize(text, 1);
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return text;
    throw error;
  }

  let out = '';
  let copiedTo = 0;
  for (const token of tokens) {
    const replacement = replace(token);
    if (replacement === null) continue;
    out += text.substring(copiedTo, token.position) + replacement;
    copiedTo = token.position + token.text.length;
  }

  return copiedTo === 0 ? text : out + text.substring(copiedTo);
}
