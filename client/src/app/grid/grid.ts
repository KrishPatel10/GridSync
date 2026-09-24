import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MAX_ROWS_PER_INSERT, SheetSyncService } from '../sync/sheet-sync.service';
import { cellAddress, columnName, parseClipboardGrid } from './cell-address';
import {
  cellAtPoint,
  isSingleCell,
  Pos,
  rangeContains,
  rangeHeight,
  rangeLabel,
  rangeOf,
  rangeToClipboardText,
  rangeWidth,
} from './selection';
import { SelectionStats, summarize } from './selection-stats';

/**
 * A cell by what it is, not where it is. A row's handle stays with that row when someone inserts
 * rows above it, so a selection or an open editor follows its row instead of silently sliding onto
 * a different one. (Positions are what the grid draws; handles are what it remembers.)
 */
interface CellRef {
  readonly handle: number;
  readonly col: number;
}

/** Geometry. Rows must all be the same height: that's what makes "which rows are visible" pure arithmetic. */
const ROW_H = 30;
const HEADER_H = 30;
const ROW_HEADER_W = 64;
const COL_W = 128;
/** Extra rows rendered above and below the viewport so fast scrolling doesn't show blank gaps. */
const OVERSCAN = 8;
/** Numbers like 42, -3.5, 1,250,000, or 12% sit right-aligned, as in any spreadsheet. */
const NUMERIC = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/;

/**
 * A hand-rolled virtualized grid. The sheet has 100,000 rows, but only the ~40 on screen
 * (plus overscan) exist in the DOM at any moment:
 *
 *   canvas height = HEADER_H + rows * ROW_H         (gives the scrollbar its true size)
 *   first visible = floor(scrollTop / ROW_H)
 *   rendered rows = translateY(first * ROW_H)       (slides the small window into place)
 *
 * Written by hand rather than with CDK virtual scroll so the header and row numbers can be
 * sticky on both axes, and so column virtualization can slot in later for very wide sheets.
 */
@Component({
  selector: 'app-grid',
  templateUrl: './grid.html',
  styleUrl: './grid.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Grid {
  protected readonly sync = inject(SheetSyncService);

  protected readonly ROW_H = ROW_H;
  protected readonly HEADER_H = HEADER_H;
  protected readonly ROW_HEADER_W = ROW_HEADER_W;
  protected readonly COL_W = COL_W;

  private readonly viewport = viewChild.required<ElementRef<HTMLDivElement>>('viewport');
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');

  private readonly scrollTop = signal(0);
  private readonly viewportSize = signal({ width: 0, height: 0 });

  /**
   * The active cell: where typing, the editor, the formula bar and other people's cursors point.
   * The selection is the rectangle between it and `anchor`, which is where the selection started.
   * They are equal for an ordinary single-cell selection.
   */
  private readonly activeRef = signal<CellRef>({ handle: 0, col: 0 });
  private readonly anchorRef = signal<CellRef>({ handle: 0, col: 0 });
  private readonly editingRef = signal<CellRef | null>(null);
  protected readonly selected = computed(() => this.posOf(this.activeRef()));
  private readonly anchor = computed(() => this.posOf(this.anchorRef()));
  protected readonly editing = computed(() => {
    const e = this.editingRef();
    return e ? this.posOf(e) : null;
  });
  private dragging = false;

  protected readonly range = computed(() => rangeOf(this.anchor(), this.selected()));
  protected readonly isMultiCell = computed(() => !isSingleCell(this.range()));

  /** Where to draw the selection rectangle, in canvas pixels: one element, however many cells it covers. */
  protected readonly rangeBox = computed(() => {
    const r = this.range();
    if (isSingleCell(r) || this.editing()) return null;
    return {
      top: HEADER_H + r.top * ROW_H,
      left: ROW_HEADER_W + r.left * COL_W,
      height: rangeHeight(r) * ROW_H,
      width: rangeWidth(r) * COL_W,
    };
  });
  protected readonly draft = signal('');

  /** Count, sum and so on for the footer. Only meaningful for more than one cell, like Excel. */
  readonly stats = computed<SelectionStats | null>(() =>
    this.isMultiCell() ? summarize(this.sync.displaysIn(this.range())) : null,
  );

  /** Where the right-click menu is open, in viewport pixels, or null when it is closed. */
  protected readonly menu = signal<{ x: number; y: number } | null>(null);

  protected readonly columns = computed(() => Array.from({ length: this.sync.dims().cols }, (_, i) => i));
  protected readonly canvasHeight = computed(() => HEADER_H + this.sync.dims().rows * ROW_H);
  protected readonly canvasWidth = computed(() => ROW_HEADER_W + this.sync.dims().cols * COL_W);

  private readonly window = computed(() => {
    const rows = this.sync.dims().rows;
    const bodyHeight = Math.max(0, this.viewportSize().height - HEADER_H);
    const first = Math.floor(this.scrollTop() / ROW_H);
    const last = Math.ceil((this.scrollTop() + bodyHeight) / ROW_H);
    return {
      start: Math.max(0, first - OVERSCAN),
      end: Math.min(rows, last + OVERSCAN),
    };
  });

  protected readonly visibleRows = computed(() => {
    const { start, end } = this.window();
    return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
  });

  protected readonly offsetY = computed(() => HEADER_H + this.window().start * ROW_H);

  /** "B2" for one cell, "B2:D5" for a block. The formula bar still shows the active cell's contents. */
  protected readonly address = computed(() => rangeLabel(this.range()));
  protected readonly selectedValue = computed(() => {
    const editing = this.editing();
    if (editing) return this.draft();
    const { row, col } = this.selected();
    return this.sync.valueAt(row, col);
  });
  protected readonly activeCellId = computed(() => `cell-${this.selected().row}-${this.selected().col}`);

  protected readonly columnName = columnName;

  constructor() {
    const destroyRef = inject(DestroyRef);

    afterNextRender(() => {
      const el = this.viewport().nativeElement;
      const observer = new ResizeObserver(([entry]) =>
        this.viewportSize.set({ width: entry.contentRect.width, height: entry.contentRect.height }),
      );
      observer.observe(el);
      destroyRef.onDestroy(() => observer.disconnect());
      el.focus();
    });

    // Focus the inline editor whenever one appears, caret at the end.
    afterRenderEffect(() => {
      const input = this.editor()?.nativeElement;
      if (input && document.activeElement !== input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
  }

  // ----- template helpers ------------------------------------------------------------------

  protected isSelected(row: number, col: number): boolean {
    const s = this.selected();
    return s.row === row && s.col === col;
  }

  /** Headers light up for every row and column the selection touches, not only the active cell's. */
  protected isRowSelected(row: number): boolean {
    const r = this.range();
    return row >= r.top && row <= r.bottom;
  }

  protected isColSelected(col: number): boolean {
    const r = this.range();
    return col >= r.left && col <= r.right;
  }

  protected isNumeric(value: string): boolean {
    return value !== '' && /\d/.test(value) && NUMERIC.test(value);
  }

  protected isEditing(row: number, col: number): boolean {
    const e = this.editing();
    return e !== null && e.row === row && e.col === col;
  }

  // ----- events ----------------------------------------------------------------------------

  protected onScroll(): void {
    this.scrollTop.set(this.viewport().nativeElement.scrollTop);
  }

  protected onCellMouseDown(event: MouseEvent, row: number, col: number): void {
    if (this.isEditing(row, col)) return; // let the click place the caret inside the editor
    if (event.button !== 0) return; // right click keeps the current selection for a context menu
    event.preventDefault(); // keep focus on the grid instead of the cell div
    this.commitEdit();
    // Shift+click extends from where the selection started; a plain click starts a new one and,
    // as long as the button stays down, dragging extends it (see onDocumentMouseMove).
    this.select(row, col, event.shiftKey);
    this.dragging = true;
    this.viewport().nativeElement.focus();
  }

  /**
   * Listens on the document, not the grid, so a drag that leaves the grid keeps working. Works out
   * the cell from the pointer position rather than from mouseenter on each cell: there are hundreds
   * of cells, and this also handles the pointer being beyond the edge (it clamps, and select()
   * scrolls the new corner into view, which is what makes dragging past the edge scroll).
   */
  protected onDocumentMouseMove(event: MouseEvent): void {
    if (!this.dragging) return;
    if (event.buttons === 0) {
      this.dragging = false; // the button was released outside the window, where we never heard about it
      return;
    }

    const el = this.viewport().nativeElement;
    const box = el.getBoundingClientRect();
    const target = cellAtPoint(
      event.clientX - box.left + el.scrollLeft,
      event.clientY - box.top + el.scrollTop,
      { rowHeight: ROW_H, colWidth: COL_W, headerHeight: HEADER_H, rowHeaderWidth: ROW_HEADER_W },
      this.sync.dims(),
    );

    const active = this.selected();
    if (target.row !== active.row || target.col !== active.col) this.select(target.row, target.col, true);
  }

  protected onCellContextMenu(event: MouseEvent, row: number, col: number): void {
    event.preventDefault();
    this.commitEdit();
    // Like Excel: right-clicking inside the selection keeps it, right-clicking outside moves it there.
    if (!rangeContains(this.range(), row, col)) this.select(row, col);
    // Keep the menu on screen: it is about 210x240, so pull it back from the right and bottom edges.
    this.menu.set({
      x: Math.min(event.clientX, window.innerWidth - 210),
      y: Math.min(event.clientY, window.innerHeight - 250),
    });
    setTimeout(() => this.menuItems()[0]?.focus());
  }

  protected closeMenu(): void {
    if (this.menu() === null) return;
    this.menu.set(null);
    this.viewport().nativeElement.focus();
  }

  protected onDocumentMouseDown(event: MouseEvent): void {
    if (this.menu() && !(event.target as Element).closest('.context-menu')) this.menu.set(null);
  }

  protected onMenuKeydown(event: KeyboardEvent): void {
    const items = this.menuItems();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') this.closeMenu();
    else if (event.key === 'ArrowDown') items[(at + 1) % items.length]?.focus();
    else if (event.key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus();
    else return;
    event.preventDefault();
  }

  protected async menuCopy(): Promise<void> {
    this.closeMenu();
    await navigator.clipboard.writeText(this.rangeText());
  }

  protected async menuCut(): Promise<void> {
    const text = this.rangeText();
    this.closeMenu();
    await navigator.clipboard.writeText(text);
    this.clearSelection();
  }

  protected async menuPaste(): Promise<void> {
    this.closeMenu();
    try {
      this.pasteText(await navigator.clipboard.readText());
    } catch {
      // The browser refused clipboard access. Ctrl+V still works, since it is a real paste event.
    }
  }

  protected menuClear(): void {
    this.closeMenu();
    this.clearSelection();
  }

  /** "Insert row above" or "Insert 3 rows below": as many rows as the selection has, like Excel. */
  protected readonly insertLabel = computed(() => {
    const n = rangeHeight(this.range());
    return n === 1 ? 'row' : `${n} rows`;
  });

  protected menuInsert(where: 'above' | 'below'): void {
    this.closeMenu();
    this.insertRows(where);
  }

  /** Inserts blank rows above or below the selection, then selects them across the same columns. */
  private insertRows(where: 'above' | 'below'): void {
    const r = this.range();
    const count = Math.min(rangeHeight(r), MAX_ROWS_PER_INSERT);
    const first = this.sync.insertRows(where === 'above' ? r.top : r.bottom + 1, count);

    this.select(first, r.left);
    this.anchorRef.set(this.refAt({ row: first + count - 1, col: r.right }));
    this.viewport().nativeElement.focus();
  }

  protected menuSelectAll(): void {
    this.closeMenu();
    this.selectAll();
  }

  private menuItems(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu button:not(:disabled)'));
  }

  private rangeText(): string {
    return rangeToClipboardText(this.range(), (row, col) => this.sync.valueAt(row, col));
  }

  protected onDocumentMouseUp(): void {
    this.dragging = false;
  }

  protected onCellDoubleClick(row: number, col: number): void {
    this.beginEdit(row, col);
  }

  protected onGridKeydown(event: KeyboardEvent): void {
    const jump = event.ctrlKey || event.metaKey;

    if (this.editing()) {
      // Normally the editor has focus and handles its own keys. But a fast typist can land the
      // next keystrokes before the editor has rendered and focused, so catch them here instead
      // of dropping characters.
      if (['Enter', 'Tab', 'Escape'].includes(event.key)) this.onEditorKeydown(event);
      else if (event.key.length === 1 && !jump && !event.altKey) {
        event.preventDefault();
        this.draft.update((text) => text + event.key);
      }
      return;
    }

    if (event.key === 'Escape' && this.menu()) {
      this.closeMenu();
      return;
    }
    if (jump && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selectAll();
      return;
    }
    // Ctrl+Shift+= (Ctrl and "+"): insert rows above the selection, as in Excel.
    if (jump && event.shiftKey && (event.key === '+' || event.key === '=')) {
      event.preventDefault();
      this.insertRows('above');
      return;
    }
    if (event.key === 'Escape' && this.isMultiCell()) {
      event.preventDefault();
      this.anchorRef.set(this.activeRef()); // back to just the active cell
      return;
    }

    const { row, col } = this.selected();
    const { rows, cols } = this.sync.dims();
    const pageRows = Math.max(1, Math.floor((this.viewportSize().height - HEADER_H) / ROW_H) - 1);
    // Shift with a movement key stretches the selection instead of moving it. Shift+Tab already
    // means "previous cell", so it is not an extension.
    const extend = event.shiftKey && event.key !== 'Tab';

    const moves: Record<string, () => Pos> = {
      ArrowUp: () => ({ row: jump ? 0 : row - 1, col }),
      ArrowDown: () => ({ row: jump ? rows - 1 : row + 1, col }),
      ArrowLeft: () => ({ row, col: jump ? 0 : col - 1 }),
      ArrowRight: () => ({ row, col: jump ? cols - 1 : col + 1 }),
      Tab: () => ({ row, col: event.shiftKey ? col - 1 : col + 1 }),
      PageUp: () => ({ row: row - pageRows, col }),
      PageDown: () => ({ row: row + pageRows, col }),
      Home: () => (jump ? { row: 0, col: 0 } : { row, col: 0 }),
      End: () => (jump ? { row: rows - 1, col: cols - 1 } : { row, col: cols - 1 }),
    };

    // Tab past the first or last column leaves the grid, so keyboard users are never trapped.
    const tabsOut = event.key === 'Tab' && (event.shiftKey ? col === 0 : col === cols - 1);
    const move = tabsOut ? undefined : moves[event.key];
    if (move) {
      event.preventDefault();
      const to = move();
      this.select(to.row, to.col, extend);
      return;
    }

    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      this.beginEdit(row, col);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.clearSelection();
    } else if (event.key.length === 1 && !jump && !event.altKey) {
      // Typing on a selected cell replaces its contents, like any spreadsheet.
      event.preventDefault();
      this.beginEdit(row, col, event.key);
    }
  }

  protected onEditorKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
    const editing = this.editing();
    if (!editing) return;

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      this.commitEdit();
      const back = event.shiftKey ? -1 : 1;
      if (event.key === 'Enter') this.select(editing.row + back, editing.col);
      else this.select(editing.row, editing.col + back);
      this.viewport().nativeElement.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.editingRef.set(null);
      this.viewport().nativeElement.focus();
    }
  }

  protected onEditorInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  protected onEditorBlur(): void {
    this.commitEdit();
  }

  protected onCopy(event: ClipboardEvent): void {
    if (this.editing()) return; // native copy inside the text box
    event.clipboardData?.setData('text/plain', this.rangeText());
    event.preventDefault();
  }

  protected onCut(event: ClipboardEvent): void {
    if (this.editing()) return;
    this.onCopy(event);
    this.clearSelection();
  }

  protected onPaste(event: ClipboardEvent): void {
    if (this.editing()) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (parseClipboardGrid(text).length === 0) return;
    event.preventDefault();
    this.pasteText(text);
  }

  private pasteText(text: string): void {
    const grid = parseClipboardGrid(text);
    if (grid.length === 0) return;

    // Pastes at the top-left of the selection, like Excel, however the selection was dragged.
    const { top: row, left: col } = this.range();
    const { rows, cols } = this.sync.dims();
    let lastRow = row;
    let lastCol = col;
    // All of these land in the same microtask, so they sync as one batched ApplyOps call.
    grid.forEach((line, r) =>
      line.forEach((value, c) => {
        if (row + r >= rows || col + c >= cols) return;
        this.sync.setCell(row + r, col + c, value);
        lastRow = Math.max(lastRow, row + r);
        lastCol = Math.max(lastCol, col + c);
      }),
    );

    // Select what was pasted, so you can see how far it went.
    this.anchorRef.set(this.refAt({ row, col }));
    this.activeRef.set(this.refAt({ row: lastRow, col: lastCol }));
    this.sync.shareSelection(lastRow, lastCol);
  }

  // ----- actions ---------------------------------------------------------------------------

  /** Moves the active cell. With `extend`, the anchor stays put, so the selection stretches to it. */
  private select(row: number, col: number, extend = false): void {
    const { rows, cols } = this.sync.dims();
    const next = { row: clamp(row, 0, rows - 1), col: clamp(col, 0, cols - 1) };
    if (!extend) this.anchorRef.set(this.refAt(next));
    this.activeRef.set(this.refAt(next));
    this.scrollIntoView(next);
    this.sync.shareSelection(next.row, next.col);
  }

  /**
   * Everything, with the active cell left where it was: like Excel, typing after Ctrl+A still
   * edits the cell you were on. (The anchor is the far corner, the active cell stays.)
   */
  private selectAll(): void {
    const { rows, cols } = this.sync.dims();
    this.anchorRef.set(this.refAt({ row: rows - 1, col: cols - 1 }));
    this.activeRef.set(this.refAt({ row: 0, col: 0 }));
    this.sync.shareSelection(0, 0);
  }

  /** Clears every cell in the selection. Cells that are already empty create no edits. */
  private clearSelection(): void {
    const r = this.range();
    for (let row = r.top; row <= r.bottom; row++) {
      for (let col = r.left; col <= r.right; col++) this.sync.setCell(row, col, null);
    }
  }

  private beginEdit(row: number, col: number, initial?: string): void {
    this.select(row, col);
    this.draft.set(initial ?? this.sync.valueAt(row, col));
    this.editingRef.set(this.refAt({ row, col }));
  }

  private commitEdit(): void {
    const editing = this.editing(); // where that row is now, even if rows were inserted while typing
    if (!editing) return;
    this.editingRef.set(null);
    this.sync.setCell(editing.row, editing.col, this.draft());
  }

  private refAt({ row, col }: Pos): CellRef {
    return { handle: this.sync.handleAt(row), col };
  }

  private posOf(ref: CellRef): Pos {
    return { row: Math.max(0, this.sync.indexOfHandle(ref.handle)), col: ref.col };
  }

  /** Scrolls just enough to bring a cell fully into view, accounting for the sticky header and row numbers. */
  private scrollIntoView({ row, col }: Pos): void {
    const el = this.viewport().nativeElement;
    const { width, height } = this.viewportSize();

    const top = row * ROW_H;
    const bodyHeight = height - HEADER_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + bodyHeight) el.scrollTop = top + ROW_H - bodyHeight;

    const left = col * COL_W;
    const bodyWidth = width - ROW_HEADER_W;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (left + COL_W > el.scrollLeft + bodyWidth) el.scrollLeft = left + COL_W - bodyWidth;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
