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

describe('register()', () => {
  it('invokes the applier synchronously with the current value at registration time', async () => {
    const { register, saveSettings } = await importSettings();
    saveSettings({ musicVolume: 0.42 });
    const seen: number[] = [];
    register('musicVolume', (v) => seen.push(v));
    expect(seen).toEqual([0.42]);
  });

  it('invokes the applier when the registered key changes', async () => {
    const { register, saveSettings } = await importSettings();
    const seen: number[] = [];
    const unreg = register('musicVolume', (v) => seen.push(v));
    // Initial dispatch with default = 1.
    expect(seen).toEqual([1]);
    saveSettings({ musicVolume: 0.5 });
    saveSettings({ musicVolume: 0.25 });
    expect(seen).toEqual([1, 0.5, 0.25]);
    unreg();
  });

  it('does NOT invoke the applier when an unrelated key changes', async () => {
    const { register, saveSettings } = await importSettings();
    const seen: number[] = [];
    register('musicVolume', (v) => seen.push(v));
    seen.length = 0; // discard the initial dispatch
    saveSettings({ sfxVolume: 0.3 });
    saveSettings({ scrollSpeedMul: 1.5 });
    saveSettings({ colorBlind: true });
    saveSettings({ tutorialSeen: true });
    saveSettings({ audioReactiveEnabled: false });
    expect(seen).toEqual([]);
  });

  it('does NOT re-fire when saveSettings writes the same value', async () => {
    // Per-key dispatch is supposed to be diff-driven so a slider that
    // settles back on its current value doesn't kick the audio engine.
    const { register, saveSettings } = await importSettings();
    saveSettings({ musicVolume: 0.7 });
    const seen: number[] = [];
    register('musicVolume', (v) => seen.push(v));
    expect(seen).toEqual([0.7]);
    saveSettings({ musicVolume: 0.7 });
    expect(seen).toEqual([0.7]);
  });

  it('detects deep changes to the keys field (KeyBindings)', async () => {
    const { register, saveSettings } = await importSettings();
    const seen: number[] = [];
    register('keys', () => seen.push(seen.length));
    seen.length = 0; // discard initial
    // Same shape, same content as defaults — should NOT fire.
    saveSettings({ keys: { left: ['KeyA'], right: ['KeyL'] } });
    expect(seen.length).toBe(1);
    saveSettings({ keys: { left: ['KeyA'], right: ['KeyL'] } });
    expect(seen.length).toBe(1);
    // Actual change → fires.
    saveSettings({ keys: { left: ['KeyB'], right: ['KeyL'] } });
    expect(seen.length).toBe(2);
  });

  it('the unregister function stops further invocations', async () => {
    const { register, saveSettings } = await importSettings();
    const seen: number[] = [];
    const unreg = register('musicVolume', (v) => seen.push(v));
    saveSettings({ musicVolume: 0.6 });
    expect(seen).toEqual([1, 0.6]);
    unreg();
    saveSettings({ musicVolume: 0.2 });
    saveSettings({ musicVolume: 0.9 });
    expect(seen).toEqual([1, 0.6]);
  });

  it('multiple appliers for the same key all fire on change', async () => {
    const { register, saveSettings } = await importSettings();
    const a: number[] = [];
    const b: number[] = [];
    register('sfxVolume', (v) => a.push(v));
    register('sfxVolume', (v) => b.push(v));
    saveSettings({ sfxVolume: 0.4 });
    expect(a).toEqual([1, 0.4]);
    expect(b).toEqual([1, 0.4]);
  });

  it('isolates applier errors so siblings + subscribers still fire', async () => {
    const { register, subscribe, saveSettings } = await importSettings();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {
      /* swallow expected applier-threw log so the suite output stays clean */
    });
    const ok: number[] = [];
    const subSeen: number[] = [];
    register('musicVolume', () => {
      throw new Error('boom');
    });
    register('musicVolume', (v) => ok.push(v));
    subscribe((s) => subSeen.push(s.musicVolume));
    ok.length = 0;
    subSeen.length = 0;
    saveSettings({ musicVolume: 0.33 });
    expect(ok).toEqual([0.33]);
    expect(subSeen).toEqual([0.33]);
    errors.mockRestore();
  });

  it('passes a defensive clone for the keys field (mutation does not corrupt the store)', async () => {
    const { register, loadSettings, saveSettings } = await importSettings();
    let received: { left: string[]; right: string[] } | null = null;
    register('keys', (k) => {
      received = { left: [...k.left], right: [...k.right] };
      // Try to corrupt the value the applier was handed.
      k.left.push('CorruptKey');
      k.right.length = 0;
    });
    saveSettings({ keys: { left: ['KeyA'], right: ['KeyL'] } });
    // The stored settings should reflect what we passed to saveSettings,
    // not the in-applier mutation.
    expect(loadSettings().keys.left).toEqual(['KeyA']);
    expect(loadSettings().keys.right).toEqual(['KeyL']);
    expect(received).toEqual({ left: ['KeyA'], right: ['KeyL'] });
  });
});

describe('subscribe() back-compat', () => {
  it('still fires on every change regardless of which field moved', async () => {
    const { subscribe, saveSettings } = await importSettings();
    const seen: number[] = [];
    const unsub = subscribe(() => seen.push(seen.length));
    // Initial dispatch.
    expect(seen).toEqual([0]);
    saveSettings({ musicVolume: 0.1 });
    saveSettings({ sfxVolume: 0.2 });
    saveSettings({ colorBlind: true });
    expect(seen).toEqual([0, 1, 2, 3]);
    unsub();
  });

  it('coexists with register() — both channels fire on the same save', async () => {
    const { subscribe, register, saveSettings } = await importSettings();
    const sub: number[] = [];
    const reg: number[] = [];
    subscribe((s) => sub.push(s.musicVolume));
    register('musicVolume', (v) => reg.push(v));
    sub.length = 0;
    reg.length = 0;
    saveSettings({ musicVolume: 0.5 });
    expect(sub).toEqual([0.5]);
    expect(reg).toEqual([0.5]);
  });
});
