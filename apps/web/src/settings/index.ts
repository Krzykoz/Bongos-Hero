/**
 * Player-facing settings: volumes, scroll-speed multiplier, color-blind palette,
 * customizable bongo key bindings.
 *
 * State lives in a single in-memory `Settings` object plus two notification
 * channels:
 *   - `subscribe(cb)` — full-snapshot callback, fires on every save (back-compat
 *     for consumers like the settings UI panel that re-render the whole thing
 *     regardless of which field changed).
 *   - `register(key, applier)` — per-key applier, fires only when that field's
 *     value actually changes (and once at registration time with the current
 *     value). Prefer this for consumers that only care about one field — it
 *     skips a diff in every consumer and avoids spurious work when unrelated
 *     settings move.
 *
 * `saveSettings` is the only mutator; it merges, persists to localStorage,
 * dispatches per-key appliers for changed fields, then dispatches all
 * full-snapshot subscribers. Both invocations are synchronous so callers can
 * rely on "save → consumers updated" within a single turn of the event loop.
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
  /**
   * When true, the renderer applies an FFT-driven edge glow on the highway
   * that pulses with the song's low-frequency (kick/bass) energy, sourced
   * from `AudioEngine.getLowBandEnergy()`. When false, both the analyser
   * sample and the edge-glow draw are skipped, so the cost is exactly zero.
   */
  audioReactiveEnabled: boolean;
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
  audioReactiveEnabled: true,
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
    audioReactiveEnabled: s.audioReactiveEnabled,
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
  if ('audioReactiveEnabled' in partial) {
    next.audioReactiveEnabled = Boolean(partial.audioReactiveEnabled);
  }
  return next;
}

let current: Settings = cloneSettings(DEFAULTS);
let hydrated = false;

const subscribers = new Set<(s: Settings) => void>();

/**
 * Per-key applier registry. Each entry maps a `Settings` key to the set of
 * functions that should run whenever that field's value changes. Stored as
 * `unknown` internally because the Map can't preserve the per-key value
 * type — the public `register()` signature reasserts the type at the
 * registration boundary, and dispatch always passes the field's actual
 * runtime value.
 */
type AnyApplier = (value: unknown) => void;
const appliers = new Map<keyof Settings, Set<AnyApplier>>();

/**
 * Canonical iteration order over `Settings` keys. Used by the diff loop in
 * `saveSettings` so adding a field is a one-line change here plus the usual
 * spots in `cloneSettings`/`normalize`.
 */
const SETTINGS_KEYS: readonly (keyof Settings)[] = [
  'musicVolume',
  'sfxVolume',
  'scrollSpeedMul',
  'colorBlind',
  'keys',
  'tutorialSeen',
  'audioReactiveEnabled',
];

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function settingsValueEqual<K extends keyof Settings>(
  key: K,
  a: Settings[K],
  b: Settings[K],
): boolean {
  if (key === 'keys') {
    const ak = a as KeyBindings;
    const bk = b as KeyBindings;
    return arraysEqual(ak.left, bk.left) && arraysEqual(ak.right, bk.right);
  }
  return a === b;
}

/**
 * Defensive clone for an individual setting value. Primitives pass through;
 * `keys` (the only nested-object field) gets a deep-ish clone so an applier
 * that mutates the value it receives can't corrupt the live store.
 */
function cloneValue<K extends keyof Settings>(key: K, value: Settings[K]): Settings[K] {
  if (key === 'keys') {
    const k = value as KeyBindings;
    return { left: [...k.left], right: [...k.right] } as Settings[K];
  }
  return value;
}

function getApplierSet(key: keyof Settings): Set<AnyApplier> {
  let set = appliers.get(key);
  if (!set) {
    set = new Set<AnyApplier>();
    appliers.set(key, set);
  }
  return set;
}

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
 * Merge `partial` into the current settings, persist to localStorage, then
 * dispatch (1) per-key appliers for fields whose value actually changed and
 * (2) every full-snapshot subscriber. Returns the post-merge full settings.
 */
export function saveSettings(partial: Partial<Settings>): Settings {
  ensureHydrated();
  // `normalize` clones `current` internally, so `prev` keeps pointing at the
  // pre-merge object and is safe to diff against `next`.
  const prev = current;
  const next = normalize(partial, prev);
  current = next;
  writeToStorage(next);

  // (1) Per-key appliers — fire only for fields whose value actually moved.
  for (const key of SETTINGS_KEYS) {
    if (settingsValueEqual(key, prev[key], next[key])) continue;
    const set = appliers.get(key);
    if (!set || set.size === 0) continue;
    // Snapshot the applier list so a callback that re-registers / unregisters
    // mid-iteration cannot mutate the live Set we're walking.
    const snapshot = Array.from(set);
    const cloned = cloneValue(key, next[key]);
    for (const fn of snapshot) {
      try {
        fn(cloned);
      } catch (err) {
        console.error(`[settings] applier for "${String(key)}" threw:`, err);
      }
    }
  }

  // (2) Full-snapshot subscribers — fire on any change (back-compat).
  const subSnapshot = Array.from(subscribers);
  const view: Settings = cloneSettings(next);
  for (const cb of subSnapshot) {
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
 *
 * Prefer `register()` if you only care about one specific field — that path
 * fires only when that field changes and hands you the value directly,
 * skipping the diff every subscriber would otherwise have to do.
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

/**
 * Per-key applier signature: receives the new value of `Settings[K]` whenever
 * that field changes, and once with the current value at registration time.
 */
export type Applier<K extends keyof Settings> = (value: Settings[K]) => void;

/**
 * Register a function to be invoked whenever `settings[key]` changes. The
 * applier is also invoked once with the current value at registration time
 * so callers can use a single code path for "apply once now" + "apply on
 * every change", just like `subscribe()`.
 *
 * Returns an unregister function. Prefer this over `subscribe()` for any
 * consumer that only depends on a single field — `register()` skips the
 * diff in the consumer and only fires when that field actually moves, so
 * a volume slider tweak doesn't, e.g., re-rebuild the keymap Sets.
 *
 * The value passed to the applier is a defensive clone for the only nested
 * field (`keys`); primitive fields pass through unchanged.
 */
export function register<K extends keyof Settings>(key: K, applier: Applier<K>): () => void {
  ensureHydrated();
  const set = getApplierSet(key);
  const wrapped = applier as AnyApplier;
  set.add(wrapped);
  try {
    applier(cloneValue(key, current[key]));
  } catch (err) {
    console.error(`[settings] register("${String(key)}") applier threw on initial dispatch:`, err);
  }
  return (): void => {
    set.delete(wrapped);
  };
}
