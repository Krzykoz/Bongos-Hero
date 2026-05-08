import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SettingsModule from '../index.js';

class MemoryStorage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
}

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal('localStorage', store);
  // The settings module hydrates a module-level cache on first access; reset
  // the module registry so each test gets a fresh hydration against the
  // freshly-stubbed storage.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importSettings(): Promise<typeof SettingsModule> {
  return await import('../index.js');
}

describe('settings.tutorialSeen', () => {
  it('defaults to false on a fresh install (empty storage)', async () => {
    const { loadSettings } = await importSettings();
    expect(loadSettings().tutorialSeen).toBe(false);
  });

  it('persists `tutorialSeen: true` through save and a module re-import', async () => {
    const { saveSettings, loadSettings } = await importSettings();
    saveSettings({ tutorialSeen: true });
    expect(loadSettings().tutorialSeen).toBe(true);

    const raw = store.getItem('bongos.settings');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ tutorialSeen: true });

    // Force a re-hydration to confirm the field round-trips through storage.
    vi.resetModules();
    const reloaded = await importSettings();
    expect(reloaded.loadSettings().tutorialSeen).toBe(true);
  });

  it('falls back to false when the stored payload predates the field', async () => {
    // Older clients wrote settings without `tutorialSeen` — make sure the
    // merge keeps the default rather than dropping back to undefined.
    store.setItem(
      'bongos.settings',
      JSON.stringify({ musicVolume: 0.4, sfxVolume: 0.6, scrollSpeedMul: 1.2, colorBlind: true }),
    );
    const { loadSettings } = await importSettings();
    const s = loadSettings();
    expect(s.tutorialSeen).toBe(false);
    expect(s.musicVolume).toBeCloseTo(0.4);
    expect(s.colorBlind).toBe(true);
  });
});
