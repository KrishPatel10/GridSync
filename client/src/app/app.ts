import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Grid } from './grid/grid';
import { SheetSyncService } from './sync/sheet-sync.service';
import { ThemePreference, ThemeService, nextTheme } from './theme/theme.service';

const SHEET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Which sheet to open: ?sheet=name in the URL, or "demo". Same rule the hub enforces. */
function sheetIdFromUrl(): string {
  const requested = new URLSearchParams(location.search).get('sheet');
  return requested && SHEET_ID.test(requested) ? requested : 'demo';
}

const STATUS_LABELS = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
} as const;

const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

@Component({
  selector: 'app-root',
  imports: [Grid],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
})
export class App {
  protected readonly sync = inject(SheetSyncService);
  protected readonly sheetId = sheetIdFromUrl();

  protected readonly theme = inject(ThemeService);

  protected readonly statusLabel = computed(() => STATUS_LABELS[this.sync.state()]);

  protected readonly themeLabel = computed(() => THEME_LABELS[this.theme.preference()]);

  protected readonly themeHint = computed(
    () => `Theme: ${this.themeLabel()}. Switch to ${THEME_LABELS[nextTheme(this.theme.preference())]}.`,
  );

  protected readonly sizeLabel = computed(() => {
    const { rows, cols } = this.sync.dims();
    return rows === 0 ? '' : `${rows.toLocaleString()} rows × ${cols} columns`;
  });

  protected readonly filledLabel = computed(() => {
    const n = this.sync.filledCount();
    return n === 1 ? '1 cell filled' : `${n.toLocaleString()} cells filled`;
  });

  protected readonly pendingLabel = computed(() => {
    const n = this.sync.pendingCount();
    return n === 1 ? '1 edit waiting to sync' : `${n.toLocaleString()} edits waiting to sync`;
  });

  constructor() {
    inject(Title).setTitle(`${this.sheetId} | GridSync`);
    this.sync.connect(this.sheetId);
  }

  protected toggleOnline(): void {
    void (this.sync.userOffline() ? this.sync.goOnline() : this.sync.goOffline());
  }

  /** Unsynced edits only live in memory in phase 1, so warn before they're thrown away. */
  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.sync.pendingCount() > 0) event.preventDefault();
  }
}
