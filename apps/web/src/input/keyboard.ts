import type { Lane } from '@bongos-hero/shared';

import {
  KEY_PAUSE,
  KEY_STARPOWER,
  LEFT_SIDE_KEYS,
  RIGHT_SIDE_KEYS,
} from './codes.js';

/** Discrete game actions that aren't lane hits. */
export type GameAction = 'pause' | 'starpower';

/** A bongo lane was struck. */
export interface BongoHit {
  type: 'bongo';
  lane: Lane;
  /** Song-time of the hit, in milliseconds, derived from the audio clock. */
  tMs: number;
  /** Raw KeyboardEvent.timeStamp in performance.now() units, for diagnostics. */
  rawTimestamp: number;
}

/** A non-lane action key was pressed. */
export interface ActionEvent {
  type: 'action';
  action: GameAction;
  /** Song-time of the action, in milliseconds, derived from the audio clock. */
  tMs: number;
  /** Raw KeyboardEvent.timeStamp in performance.now() units, for diagnostics. */
  rawTimestamp: number;
}

/** Anything the input layer can emit. */
export type InputEvent = BongoHit | ActionEvent;

export interface KeyboardInputOptions {
  /**
   * Returns the current song time in ms (audio-clock derived).
   * Wire this to AudioEngine.currentTimeMs.bind(engine).
   */
  getSongTimeMs: () => number;
  /**
   * Optional: convert a KeyboardEvent.timeStamp (performance.now() units) into
   * a song-time correction (ms). Defaults to 0 — the simple implementation just
   * uses getSongTimeMs() at handle time. Pass a function if you want
   * sub-frame-accurate timing.
   */
  timestampToSongMs?: (rawTimestamp: number) => number;
  /** DOM target to attach to. Default: window. */
  target?: Window | HTMLElement;
  /**
   * Per-lane coalescing window in raw `event.timeStamp` ms. Two presses on the
   * same lane that arrive within this window are collapsed into one — this
   * prevents two fingers landing simultaneously from registering one hit + one
   * stray (combo break). Cross-lane presses are NEVER coalesced (fast L↔R
   * alternation must remain crisp).
   *
   * Default: 25 ms. Set to 0 to disable.
   */
  sameLaneCoalesceMs?: number;
}

type Listener = (ev: InputEvent) => void;

const DEFAULT_COALESCE_MS = 25;

/**
 * Returns true when the focused element is a text-entry surface where we
 * should not steal keystrokes (e.g. the YouTube URL field in the import scene).
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Keyboard input layer for Bongos Hero.
 *
 * Supports full-side "mash" controls: every physical key on the left half of
 * the keyboard counts as a left-bongo strike, every key on the right half as a
 * right-bongo strike (see `LEFT_SIDE_KEYS` / `RIGHT_SIDE_KEYS`). Space and
 * Escape remain reserved for Star Power and pause respectively.
 *
 * OS auto-repeat is suppressed. Modifier-held shortcuts (Ctrl/Cmd/Alt) are
 * ignored so browser shortcuts like Cmd+R / Cmd+T still work. Held-key state
 * is exposed for visual lane glow.
 */
export class KeyboardInput {
  private readonly opts: KeyboardInputOptions;
  private readonly target: Window | HTMLElement;
  private readonly listeners = new Set<Listener>();
  private readonly held = new Set<string>();
  private attached = false;

  /** Last raw timestamp (event.timeStamp) of an emitted bongo for each lane. */
  private lastBongoTsL = -Infinity;
  private lastBongoTsR = -Infinity;
  private readonly coalesceMs: number;

  constructor(opts: KeyboardInputOptions) {
    this.opts = opts;
    this.target = opts.target ?? window;
    this.coalesceMs = opts.sameLaneCoalesceMs ?? DEFAULT_COALESCE_MS;
  }

  /** Begin listening. Idempotent. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;

    const target = this.target as EventTarget;
    target.addEventListener('keydown', this.onKeyDown as EventListener, { passive: false });
    target.addEventListener('keyup', this.onKeyUp as EventListener, { passive: false });
    target.addEventListener('blur', this.onBlur as EventListener);

    // Visibility lives on `document`, not `window`/element targets.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  /** Stop listening and clear pending state. Idempotent. */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;

    const target = this.target as EventTarget;
    target.removeEventListener('keydown', this.onKeyDown as EventListener);
    target.removeEventListener('keyup', this.onKeyUp as EventListener);
    target.removeEventListener('blur', this.onBlur as EventListener);

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }

    this.held.clear();
  }

  /** Subscribe to events. Returns an unsubscribe function. */
  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** True if any key on the given lane's side of the keyboard is currently held. */
  isLanePressed(lane: Lane): boolean {
    const set = lane === 'L' ? LEFT_SIDE_KEYS : RIGHT_SIDE_KEYS;
    for (const code of this.held) {
      if (set.has(code)) return true;
    }
    return false;
  }

  /** True if the action key is currently held. */
  isActionPressed(action: GameAction): boolean {
    return this.held.has(action === 'pause' ? KEY_PAUSE : KEY_STARPOWER);
  }

  // ---------- internals ----------

  private isHandled(code: string): boolean {
    if (code === KEY_STARPOWER || code === KEY_PAUSE) return true;
    return LEFT_SIDE_KEYS.has(code) || RIGHT_SIDE_KEYS.has(code);
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    // Ignore modifier-held chords so browser/OS shortcuts (Cmd+R, Ctrl+T,
    // Alt+Tab, Cmd+L, etc.) still work even though their letter key is in
    // our mash sets.
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (!this.isHandled(ev.code)) return;
    if (isTextEntryTarget(ev.target)) return;

    // Always swallow our keys so Space doesn't scroll, etc.
    ev.preventDefault();

    // Suppress OS auto-repeat — without this, holding F fires every ~30ms.
    if (ev.repeat) return;

    this.held.add(ev.code);

    const tMs = this.opts.timestampToSongMs?.(ev.timeStamp) ?? this.opts.getSongTimeMs();
    const rawTimestamp = ev.timeStamp;

    if (ev.code === KEY_STARPOWER) {
      this.emit({ type: 'action', action: 'starpower', tMs, rawTimestamp });
      return;
    }
    if (ev.code === KEY_PAUSE) {
      this.emit({ type: 'action', action: 'pause', tMs, rawTimestamp });
      return;
    }

    const lane: Lane | null = LEFT_SIDE_KEYS.has(ev.code)
      ? 'L'
      : RIGHT_SIDE_KEYS.has(ev.code)
        ? 'R'
        : null;
    if (lane === null) return; // unreachable given isHandled above

    // Per-lane coalescing: drop a press that lands within `coalesceMs` of the
    // previous same-lane press. Uses raw event.timeStamp (perf.now units) so
    // it is independent of the audio clock state.
    if (this.coalesceMs > 0) {
      const lastTs = lane === 'L' ? this.lastBongoTsL : this.lastBongoTsR;
      if (rawTimestamp - lastTs < this.coalesceMs) return;
    }
    if (lane === 'L') this.lastBongoTsL = rawTimestamp;
    else this.lastBongoTsR = rawTimestamp;

    this.emit({ type: 'bongo', lane, tMs, rawTimestamp });
  };

  private readonly onKeyUp = (ev: KeyboardEvent): void => {
    if (!this.isHandled(ev.code)) return;
    if (isTextEntryTarget(ev.target)) return;
    ev.preventDefault();
    this.held.delete(ev.code);
  };

  private readonly onBlur = (): void => {
    // Otherwise a key released while the tab is hidden stays "pressed" forever
    // and the lane glow never turns off.
    this.held.clear();
  };

  private readonly onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.held.clear();
    }
  };

  private emit(ev: InputEvent): void {
    for (const cb of this.listeners) {
      cb(ev);
    }
  }
}
