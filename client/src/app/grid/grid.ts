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
import { SheetSyncService } from '../sync/sheet-sync.service';
import { cellAddress, columnName, parseClipboardGrid } from './cell-address';

/** Geometry. Rows must all be the same height: that's what makes "which rows are visible" pure arithmetic. */
const ROW_H = 30;
const HEADER_H = 30;
const ROW_HEADER_W = 64;
const COL_W = 128;
/** Extra rows rendered above and below the viewport so fast scrolling doesn't show blank gaps. */
const OVERSCAN = 8;
/** Numbers like 42, -3.5, 1,250,000, or 12% sit right-aligned, as in any spreadsheet. */
const NUMERIC = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/;

interface Pos {
  row: number;
  col: number;
}

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

  protected readonly selected = signal<Pos>({ row: 0, col: 0 });
  protected readonly editing = signal<Pos | null>(null);
  protected readonly draft = signal('');

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

  protected readonly address = computed(() => cellAddress(this.selected().row, this.selected().col));
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
    event.preventDefault(); // keep focus on the grid instead of the cell div
    this.commitEdit();
    this.select(row, col);
    this.viewport().nativeElement.focus();
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

    const { row, col } = this.selected();
    const { rows, cols } = this.sync.dims();
    const pageRows = Math.max(1, Math.floor((this.viewportSize().height - HEADER_H) / ROW_H) - 1);

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
      this.select(to.row, to.col);
      return;
    }

    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      this.beginEdit(row, col);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.sync.setCell(row, col, null);
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
      this.editing.set(null);
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
    const { row, col } = this.selected();
    event.clipboardData?.setData('text/plain', this.sync.valueAt(row, col));
    event.preventDefault();
  }

  protected onPaste(event: ClipboardEvent): void {
    if (this.editing()) return;
    const grid = parseClipboardGrid(event.clipboardData?.getData('text/plain') ?? '');
    if (grid.length === 0) return;
    event.preventDefault();

    const { row, col } = this.selected();
    const { rows, cols } = this.sync.dims();
    // All of these land in the same microtask, so they sync as one batched ApplyOps call.
    grid.forEach((line, r) =>
      line.forEach((value, c) => {
        if (row + r < rows && col + c < cols) this.sync.setCell(row + r, col + c, value);
      }),
    );
  }

  // ----- actions ---------------------------------------------------------------------------

  private select(row: number, col: number): void {
    const { rows, cols } = this.sync.dims();
    const next = { row: clamp(row, 0, rows - 1), col: clamp(col, 0, cols - 1) };
    this.selected.set(next);
    this.scrollIntoView(next);
    this.sync.shareSelection(next.row, next.col);
  }

  private beginEdit(row: number, col: number, initial?: string): void {
    this.select(row, col);
    this.draft.set(initial ?? this.sync.valueAt(row, col));
    this.editing.set({ row, col });
  }

  private commitEdit(): void {
    const editing = this.editing();
    if (!editing) return;
    this.editing.set(null);
    this.sync.setCell(editing.row, editing.col, this.draft());
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
