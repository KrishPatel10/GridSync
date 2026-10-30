import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { Grid } from '../grid/grid';
import { GRID_DATA } from '../grid/grid-data';
import { describeStep, StepDescription } from './describe-step';
import { HistoryApi } from './history-api';
import { HistoryGridData } from './history-grid-data';

/** Wait this long after the slider stops before asking for that version, so dragging past 40 steps is not 40 requests. */
const SETTLE_MS = 120;

/**
 * A read-only look at the sheet as it was after any number of its edits, with the live sheet
 * untouched behind it. The grid is the same one the live sheet uses; it is handed a different data
 * source (HistoryGridData) for just this view, through the GRID_DATA token.
 *
 * "Step 12 of 40" means the sheet after its first 12 edits. The slider starts at the last one, so
 * the first thing you see matches the live sheet, and dragging left goes back in time.
 */
@Component({
  selector: 'app-history',
  imports: [Grid],
  templateUrl: './history-view.html',
  styleUrl: './history-view.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [HistoryGridData, { provide: GRID_DATA, useExisting: HistoryGridData }],
})
export class HistoryView implements OnInit {
  readonly sheetId = input.required<string>();
  readonly closed = output<void>();

  private readonly api = inject(HistoryApi);
  private readonly data = inject(HistoryGridData);

  /** Edits the sheet had when this opened, or when a later request saw more. */
  protected readonly count = signal(0);
  protected readonly step = signal(0);
  protected readonly loaded = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly what = signal<StepDescription | null>(null);

  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.settleTimer);
      this.request?.abort();
    });
  }

  ngOnInit(): void {
    void this.open();
  }

  protected atTime(at: Date): string {
    return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  }

  /** Moves to a step, clamped to what exists. The number moves at once; the sheet follows when the slider settles. */
  protected go(to: number): void {
    const step = Math.min(Math.max(Math.trunc(to), 0), this.count());
    this.step.set(step);
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => void this.show(step), SETTLE_MS);
  }

  protected onSlide(event: Event): void {
    this.go(Number((event.target as HTMLInputElement).value));
  }

  protected retry(): void {
    this.failure.set(null);
    void (this.loaded() ? this.show(this.step()) : this.open());
  }

  private async open(): Promise<void> {
    try {
      const count = await this.api.count(this.sheetId());
      this.count.set(count);
      this.step.set(count);
      await this.show(count);
    } catch (error) {
      this.failure.set(messageOf(error));
    }
  }

  private async show(step: number): Promise<void> {
    this.request?.abort(); // only the version the person stopped on matters
    const request = (this.request = new AbortController());
    try {
      const result = await this.api.step(this.sheetId(), step, request.signal);
      if (request !== this.request) return; // a newer request took over while this one was arriving

      this.data.load(result);
      this.what.set(describeStep(result, this.data.rowOrder));
      this.count.update((known) => Math.max(known, result.count)); // the sheet may have grown since it opened
      this.failure.set(null);
      this.loaded.set(true);
    } catch (error) {
      if (!request.signal.aborted) this.failure.set(messageOf(error));
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The history could not be loaded.';
}
