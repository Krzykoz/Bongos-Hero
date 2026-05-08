/**
 * Player-facing settings: volumes, scroll-speed multiplier, color-blind palette,
 * customizable bongo key bindings.
 *
 * State lives in a single in-memory `Settings` object plus a `Set` of
 * subscribers. `saveSettings` is the only mutator; it merges, persists to
 * localStorage, and notifies. `subscribe` invokes the callback synchronously
 * with the current settings on subscribe so callers can use the same code
 * path for "apply once now" and "apply on every change".
 *
 * Every numeric field is clamped to its declared range on both load and save;
 * every `localStorage` access is wrapped in try/catch (private-mode safety).
 *
 * Key-binding lists are deduped on load + save and fall back to the stock
 * physical-half mash sets if a list ends up empty after normalisation.
 */

/**
 * Per-side bongo key-binding lists. Each entry is a `KeyboardEvent.code`
 * value (layout-independent — see `apps/web/src/input/keyboard.ts`). Both
 * lists must contain at least one entry; the load/save layer enforces that
 * by falling back to `DEFAULTS.keys` when a list is empty.
 */
export interface KeyBindings {
  left: string[];
  right: string[];
}

export interface Settings {
  /** Music master volume, 0..1. */
  musicVolume: number;
  /** SFX master volume, 0..1. */
  sfxVolume: number;
  /** Note-highway scroll-speed multiplier, 0.5..2.0. */
  scrollSpeedMul: number;
  /** Use the color-blind-friendly palette. */
  colorBlind: boolean;
  /** Customizable bongo key bindings (left + right `KeyboardEvent.code` lists). */
  keys: KeyBindings;
  /**
   * True once the player has seen (or skipped through) the built-in tutorial
   * at least once. Drives the first-run auto-jump from `main.ts` so returning
   * players boot straight into the title screen. The tutorial scene flips
   * this to `true` on completion or Esc; replay is always available via the
   * `T` hotkey on the title.
   */
  tutorialSeen: boolean;
}

/**
 * Default key lists — copied verbatim from the original physical-half mash
 * sets in `apps/web/src/input/sides.ts` so the out-of-the-box behavior is
 * unchanged for any player who never visits the rebinding UI.
 */
const DEFAULT_LEFT_KEYS: readonly string[] = Object.freeze([
  'Backquote',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'KeyQ',
  'KeyW',
  'KeyE',
  'KeyR',
  'KeyT',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyF',
  'KeyG',
  'KeyZ',
  'KeyX',
  'KeyC',
  'KeyV',
  'KeyB',
]);

const DEFAULT_RIGHT_KEYS: readonly string[] = Object.freeze([
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Digit0',
  'Minus',
  'Equal',
  'KeyY',
  'KeyU',
  'KeyI',
  'KeyO',
  'KeyP',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'KeyH',
  'KeyJ',
  'KeyK',
  'KeyL',
  'Semicolon',
  'Quote',
  'KeyN',
  'KeyM',
  'Comma',
  'Period',
  'Slash',
]);

export const DEFAULTS: Readonly<Settings> = Object.freeze({
  musicVolume: 1,
  sfxVolume: 1,
  scrollSpeedMul: 1,
  colorBlind: false,
  keys: Object.freeze({
    left: DEFAULT_LEFT_KEYS as string[],
    right: DEFAULT_RIGHT_KEYS as string[],
  }),
  tutorialSeen: false,
});

const STORAGE_KEY = 'bongos.settings';

const RANGES: Readonly<
  Record<'musicVolume' | 'sfxVolume' | 'scrollSpeedMul', readonly [number, number]>
> = {
  musicVolume: [0, 1],
  sfxVolume: [0, 1],
  scrollSpeedMul: [0.5, 2.0],
};

function clampNumeric(key: keyof typeof RANGES, value: unknown): number {
  const [lo, hi] = RANGES[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULTS[key];
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function dedupeKeyList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') continue;
    if (item.length === 0) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  if (out.length === 0) return [...fallback];
  return out;
}

function normalizeKeys(value: unknown): KeyBindings {
  if (value === null || typeof value !== 'object') {
    return { left: [...DEFAULT_LEFT_KEYS], right: [...DEFAULT_RIGHT_KEYS] };
  }
  const v = value as { left?: unknown; right?: unknown };
  return {
    left: dedupeKeyList(v.left, DEFAULT_LEFT_KEYS),
    right: dedupeKeyList(v.right, DEFAULT_RIGHT_KEYS),
  };
}

function cloneSettings(s: Settings): Settings {
  return {
    musicVolume: s.musicVolume,
    sfxVolume: s.sfxVolume,
    scrollSpeedMul: s.scrollSpeedMul,
    colorBlind: s.colorBlind,
    keys: { left: [...s.keys.left], right: [...s.keys.right] },
    tutorialSeen: s.tutorialSeen,
  };
}

function normalize(partial: Partial<Settings>, base: Settings): Settings {
  const next: Settings = cloneSettings(base);
  if ('musicVolume' in partial) next.musicVolume = clampNumeric('musicVolume', partial.musicVolume);
  if ('sfxVolume' in partial) next.sfxVolume = clampNumeric('sfxVolume', partial.sfxVolume);
  if ('scrollSpeedMul' in partial) {
    next.scrollSpeedMul = clampNumeric('scrollSpeedMul', partial.scrollSpeedMul);
  }
  if ('colorBlind' in partial) next.colorBlind = Boolean(partial.colorBlind);
  if ('keys' in partial) next.keys = normalizeKeys(partial.keys);
  if ('tutorialSeen' in partial) next.tutorialSeen = Boolean(partial.tutorialSeen);
  return next;
}

let current: Settings = cloneSettings(DEFAULTS);
let hydrated = false;

const subscribers = new Set<(s: Settings) => void>();

function readFromStorage(): Settings {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return cloneSettings(DEFAULTS);
  }
  if (raw == null) return cloneSettings(DEFAULTS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cloneSettings(DEFAULTS);
  }
  if (parsed === null || typeof parsed !== 'object') return cloneSettings(DEFAULTS);
  return normalize(parsed, cloneSettings(DEFAULTS));
}

function writeToStorage(s: Settings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode, quota exceeded, or no DOM — never fail out of public API */
  }
}

function ensureHydrated(): void {
  if (hydrated) return;
  current = readFromStorage();
  hydrated = true;
}

/** Load settings, merging localStorage on top of DEFAULTS. Corrupt JSON → DEFAULTS. */
export function loadSettings(): Settings {
  ensureHydrated();
  return cloneSettings(current);
}

/**
 * Merge `partial` into the current settings, persist to localStorage, and
 * notify every subscriber synchronously. Returns the post-merge full settings.
 */
export function saveSettings(partial: Partial<Settings>): Settings {
  ensureHydrated();
  const next = normalize(partial, current);
  current = next;
  writeToStorage(next);
  // Iterate a snapshot so a callback that calls subscribe()/unsubscribe()
  // mid-iteration cannot mutate the live Set we're walking.
  const snapshot = Array.from(subscribers);
  const view: Settings = cloneSettings(next);
  for (const cb of snapshot) {
    try {
      cb(view);
    } catch (err) {
      console.error('[settings] subscriber threw:', err);
    }
  }
  return cloneSettings(next);
}

/**
 * Subscribe to settings changes. The callback is invoked SYNCHRONOUSLY with
 * the current settings on subscribe (so callers can use the same code path
 * for "apply once" + "apply on change"). Returns an unsubscribe function.
 */
export function subscribe(cb: (s: Settings) => void): () => void {
  ensureHydrated();
  subscribers.add(cb);
  try {
    cb(cloneSettings(current));
  } catch (err) {
    console.error('[settings] subscriber threw on initial dispatch:', err);
  }
  return (): void => {
    subscribers.delete(cb);
  };
}
