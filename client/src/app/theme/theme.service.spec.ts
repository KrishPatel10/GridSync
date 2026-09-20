import { TestBed } from '@angular/core/testing';
import { THEME_STORAGE_KEY, ThemeService, nextTheme, parseTheme } from './theme.service';

describe('theme helpers', () => {
  it('only accepts light and dark, everything else follows the system', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('system')).toBe('system');
    expect(parseTheme(null)).toBe('system');
    expect(parseTheme('sepia')).toBe('system');
  });

  it('cycles system, light, dark and back', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
  });
});

describe('ThemeService', () => {
  const root = document.documentElement;

  beforeEach(() => {
    localStorage.clear();
    root.removeAttribute('data-theme');
    TestBed.resetTestingModule();
  });

  it('starts on system and leaves data-theme off', () => {
    const theme = TestBed.inject(ThemeService);
    expect(theme.preference()).toBe('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('pins the theme on the root element and remembers it', () => {
    const theme = TestBed.inject(ThemeService);
    theme.set('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    theme.set('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('restores the saved choice on the next load', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const theme = TestBed.inject(ThemeService);
    expect(theme.preference()).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');
  });
});
