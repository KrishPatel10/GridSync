import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { GRID_DATA } from './grid/grid-data';
import { SheetSyncService } from './sync/sheet-sync.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // The grid shows the live sheet unless a view (the history view) provides another source.
    { provide: GRID_DATA, useExisting: SheetSyncService },
  ],
};
