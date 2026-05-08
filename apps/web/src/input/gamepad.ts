/**
 * Gamepad input layer for Bongos Hero.
 *
 * Polls `navigator.getGamepads()` once per `requestAnimationFrame` tick (the
 * Gamepad API has no DOM events for button presses — polling is required) and
 * fires lane press / release callbacks on rising / falling edges. Designed to
 * sit alongside the keyboard layer: it does NOT replace `KeyboardInput`, it
 * runs in parallel and dispatches the same lane semantics.
 *
 * Standard Gamepad API mapping (W3C "standard" gamepad). These indices are
 * stable across the major controllers (Xbox, PlayStation, Switch Pro, generic
 * USB pads) when the browser reports `mapping === 'standard'`:
 *
 *   0 = bottom face (A / Cross)
 *   1 = right face  (B / Circle)
 *   2 = left face   (X / Square)
 *   3 = top face    (Y / Triangle)
 *   4 = L1 / LB     (left bumper)
 *   5 = R1 / RB     (right bumper)
 *
 * The default mapping prefers the BUMPERS (4 / 5) for L / R bongos because
 * shoulder buttons feel the most "drum-like" on a gamepad and let both index
 * fingers mash without the thumbs leaving the sticks. The bottom-row face
 * buttons (0 = A / Cross → L, 1 = B / Circle → R) are also included in the
 * default as a fallback for pads where the bumpers are broken or for players
 * who prefer thumbs. Pass an explicit `buttonMap` to override (the value is
 * shallow-merged onto the default; a value of `undefined` removes a default).
 *
 * Hot-plug: the Gamepad API surfaces `gamepadconnected` / `gamepaddisconnected`
 * window events, but `navigator.getGamepads()` already returns the new device
 * on the very next frame, so the listeners here are intentionally no-ops kept
 * around only so they can be cleanly removed in `dispose()`.
 *
 * Lane aggregation: we track per-(gamepadIndex, buttonIndex) pressed state and
 * a per-lane refcount. `onLanePress(lane)` fires when the lane refcount goes
 * 0 → 1; `onLaneRelease(lane)` fires when it goes 1 → 0. That matches the
 * play scene's existing keyboard semantics — releasing one of two keys bound
 * to the same lane never breaks a sustain, and the same is true here for two
 * buttons mapped to the same lane (or a hold across two simultaneously
 * connected pads).
 *
 * Hot-path discipline: the per-frame poll allocates nothing after the first
 * tick. State lives in a single `Map<number, boolean>` keyed by the packed
 * `(gpIdx << 8) | btnIdx` integer; counter updates use locals; we use indexed
 * `for` loops over the gamepad list to avoid iterator allocations.
 */

const STANDARD_BUTTON_LB = 4;
const STANDARD_BUTTON_RB = 5;
const STANDARD_BUTTON_A = 0;
const STANDARD_BUTTON_B = 1;

const DEFAULT_BUTTON_MAP: Readonly<Record<number, 'L' | 'R'>> = Object.freeze({
  [STANDARD_BUTTON_A]: 'L',
  [STANDARD_BUTTON_B]: 'R',
  [STANDARD_BUTTON_LB]: 'L',
  [STANDARD_BUTTON_RB]: 'R',
});

export interface GamepadInputOptions {
  /** Fired when ALL mapped buttons for a lane have just gone from un-held → held. */
  onLanePress: (lane: 'L' | 'R') => void;
  /** Fired when ALL mapped buttons for a lane have just gone from held → un-held. */
  onLaneRelease: (lane: 'L' | 'R') => void;
  /**
   * Map gamepad button indices to lanes. Shallow-merged onto
   * `{ 0: 'L', 1: 'R', 4: 'L', 5: 'R' }`. Pass an explicit `undefined` to
   * unmap a default entry — e.g. `{ 0: undefined, 1: undefined }` for
   * shoulders only.
   */
  buttonMap?: Partial<Record<number, 'L' | 'R' | undefined>>;
  /**
   * Optional per-frame gate. Returning `false` skips edge detection AND
   * release-on-disconnect handling for that frame. Used by the consumer to
   * implement a "gamepad enabled" toggle without rebuilding the handle.
   * Default: always enabled.
   */
  enabled?: () => boolean;
}

export interface GamepadInputHandle {
  /** Stop polling and remove all window listeners. Idempotent. */
  dispose(): void;
  /**
   * Imperatively enable / disable the poller. While disabled the rAF loop
   * still ticks (so re-enabling is instant) but no edges are detected and
   * no callbacks fire. Equivalent to wiring an `enabled` callback that
   * returns the same boolean.
   */
  setEnabled(enabled: boolean): void;
}

/**
 * Pack a (gamepadIndex, buttonIndex) pair into a single 32-bit number we can
 * use as a Map key without string allocations. 8 bits for button index is
 * plenty (the standard mapping uses 17 buttons; even oversized pads stay
 * well under 256).
 */
function packKey(gpIdx: number, btnIdx: number): number {
  return (gpIdx << 8) | (btnIdx & 0xff);
}

export function startGamepadInput(opts: GamepadInputOptions): GamepadInputHandle {
  const buttonMap: Record<number, 'L' | 'R' | undefined> = { ...DEFAULT_BUTTON_MAP };
  if (opts.buttonMap) {
    for (const key of Object.keys(opts.buttonMap)) {
      buttonMap[Number(key)] = opts.buttonMap[Number(key)];
    }
  }

  const pressed = new Map<number, boolean>();
  let leftCount = 0;
  let rightCount = 0;
  let rafId: number | null = null;
  let disposed = false;
  let enabledFlag = true;

  const noop = (): void => {
    // Hot-plug events are surfaced only so the listeners can be removed in
    // dispose(); the poller picks up new / removed devices the next frame
    // via `navigator.getGamepads()`.
  };

  const win: (Window & typeof globalThis) | undefined =
    typeof window !== 'undefined' ? window : undefined;
  const nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined;

  function laneFor(btnIdx: number): 'L' | 'R' | undefined {
    return buttonMap[btnIdx];
  }

  function bumpLane(lane: 'L' | 'R', delta: 1 | -1): void {
    if (lane === 'L') {
      leftCount += delta;
      if (delta === 1 && leftCount === 1) opts.onLanePress('L');
      else if (delta === -1 && leftCount === 0) opts.onLaneRelease('L');
    } else {
      rightCount += delta;
      if (delta === 1 && rightCount === 1) opts.onLanePress('R');
      else if (delta === -1 && rightCount === 0) opts.onLaneRelease('R');
    }
  }

  function poll(): void {
    if (disposed) return;
    rafId = (win ?? globalThis).requestAnimationFrame(poll);

    if (!enabledFlag) return;
    if (opts.enabled && !opts.enabled()) return;

    const gamepads = nav?.getGamepads ? nav.getGamepads() : null;

    // Pass 1: handle releases & disconnects. Walk the previously-pressed
    // entries, see if any are no longer pressed (button up, or device gone),
    // and decrement the per-lane refcount.
    if (pressed.size > 0) {
      for (const [key, wasPressed] of pressed) {
        if (!wasPressed) continue;
        const gpIdx = key >>> 8;
        const btnIdx = key & 0xff;
        let isPressed = false;
        if (gamepads) {
          const gp = gamepads[gpIdx];
          if (gp) {
            const btn = gp.buttons[btnIdx];
            if (btn) isPressed = btn.pressed === true;
          }
        }
        if (!isPressed) {
          pressed.set(key, false);
          const lane = laneFor(btnIdx);
          if (lane !== undefined) bumpLane(lane, -1);
        }
      }
    }

    // Pass 2: handle presses. Iterate the live gamepad list; for each mapped
    // button that is pressed AND wasn't pressed last frame, increment the
    // per-lane refcount.
    if (!gamepads) return;
    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (!gp) continue;
      const buttons = gp.buttons;
      for (let b = 0; b < buttons.length; b++) {
        const lane = laneFor(b);
        if (lane === undefined) continue;
        const btn = buttons[b];
        if (!btn) continue;
        const isPressed = btn.pressed === true;
        if (!isPressed) continue;
        const key = packKey(i, b);
        const wasPressed = pressed.get(key) === true;
        if (!wasPressed) {
          pressed.set(key, true);
          bumpLane(lane, 1);
        }
      }
    }
  }

  if (win) {
    win.addEventListener('gamepadconnected', noop);
    win.addEventListener('gamepaddisconnected', noop);
  }
  rafId = (win ?? globalThis).requestAnimationFrame(poll);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (rafId !== null) {
        (win ?? globalThis).cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (win) {
        win.removeEventListener('gamepadconnected', noop);
        win.removeEventListener('gamepaddisconnected', noop);
      }
      pressed.clear();
      leftCount = 0;
      rightCount = 0;
    },
    setEnabled(enabled: boolean): void {
      enabledFlag = enabled;
    },
  };
}
