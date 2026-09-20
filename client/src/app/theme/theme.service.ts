import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';

/** Also read by the inline script in index.html, which applies the theme before the first paint. */
export const THEME_STORAGE_KEY = 'gridsync-theme';

const CYCLE: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** Anything we don't recognise (missing, hand-edited, from an older build) means "follow the system". */
export function parseTheme(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function nextTheme(current: ThemePreference): ThemePreference {
  return CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length];
}

/**
 * The user's theme choice. "system" leaves data-theme off so the OS setting decides through
 * color-scheme in styles.css; "light" and "dark" pin it. Storage can throw (private windows,
 * blocked site data), so the app still works without it, it just forgets the choice.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  readonly preference = signal<ThemePreference>(parseTheme(this.read()));

  constructor() {
    this.apply(this.preference());
  }

  set(preference: ThemePreference): void {
    this.preference.set(preference);
    this.apply(preference);
    try {
      this.document.defaultView?.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Not persisted; the choice still holds for this page load.
    }
  }

  cycle(): void {
    this.set(nextTheme(this.preference()));
  }

  private read(): string | null {
    try {
      return this.document.defaultView?.localStorage.getItem(THEME_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private apply(preference: ThemePreference): void {
    const root = this.document.documentElement;
    if (preference === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', preference);
  }
}
