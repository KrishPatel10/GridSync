import { cellAddress } from './cell-address';

export interface Pos {
  readonly row: number;
  readonly col: number;
}

/** A rectangle of cells, inclusive on every side. */
export interface Range {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/**
 * The rectangle between two corners, whichever way it was dragged. A selection is stored as an
 * anchor (where it started) and an active cell (the corner that moves); the rectangle is derived,
 * so extending in any direction never needs special cases.
 */
export function rangeOf(anchor: Pos, active: Pos): Range {
  return {
    top: Math.min(anchor.row, active.row),
    left: Math.min(anchor.col, active.col),
    bottom: Math.max(anchor.row, active.row),
    right: Math.max(anchor.col, active.col),
  };
}

export function isSingleCell(range: Range): boolean {
  return range.top === range.bottom && range.left === range.right;
}

export function rangeHeight(range: Range): number {
  return range.bottom - range.top + 1;
}

export function rangeWidth(range: Range): number {
  return range.right - range.left + 1;
}

export function rangeContains(range: Range, row: number, col: number): boolean {
  return row >= range.top && row <= range.bottom && col >= range.left && col <= range.right;
}

/** "B2" for one cell, "B2:D5" for a block. */
export function rangeLabel(range: Range): string {
  const start = cellAddress(range.top, range.left);
  return isSingleCell(range) ? start : `${start}:${cellAddress(range.bottom, range.right)}`;
}

/**
 * The block as tab-separated columns and newline-separated rows, which is what Excel and Google
 * Sheets put on the clipboard and what parseClipboardGrid reads back.
 */
export function rangeToClipboardText(range: Range, valueAt: (row: number, col: number) => string): string {
  const lines: string[] = [];
  for (let row = range.top; row <= range.bottom; row++) {
    const cells: string[] = [];
    for (let col = range.left; col <= range.right; col++) cells.push(valueAt(row, col));
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

/**
 * The cell under a point, given where the point is relative to the scrolled canvas. Clamped to the
 * sheet, so dragging past an edge selects the last row or column instead of nothing.
 */
export function cellAtPoint(
  x: number,
  y: number,
  geometry: { rowHeight: number; colWidth: number; headerHeight: number; rowHeaderWidth: number },
  dims: { rows: number; cols: number },
): Pos {
  const row = Math.floor((y - geometry.headerHeight) / geometry.rowHeight);
  const col = Math.floor((x - geometry.rowHeaderWidth) / geometry.colWidth);
  return {
    row: Math.min(Math.max(row, 0), dims.rows - 1),
    col: Math.min(Math.max(col, 0), dims.cols - 1),
  };
}
