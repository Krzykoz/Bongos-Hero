/**
 * Touch input layer for Bongos Hero.
 *
 * Listens for Pointer Events on a target element (typically the game canvas)
 * and dispatches lane press / release callbacks via a caller-supplied
 * `hitTest` function that maps client (x, y) coordinates to L / R / null.
 * Mirrors the keyboard + gamepad layers so the play scene can wire the same
 * scoring API regardless of which input device is in use.
 *
 * Per-pointer state + per-lane refcount semantics:
 *   - When a pointer goes down inside a tap zone, it is bound to that lane
 *     (`pointerLane.set(id, lane)`) and the lane refcount is incremented.
 *   - The lane refcount going 0 → 1 fires `onLanePress(lane)`. Subsequent
 *     fingers on the SAME zone increment the count without re-firing.
 *   - On pointerup / pointercancel / pointerleave, the bound lane's refcount
 *     is decremented; only when it reaches 0 does `onLaneRelease(lane)` fire.
 *
 * This mirrors the keyboard chord-stripping + the gamepad multi-button
 * aggregation: a sustain stays armed while ANY finger is still down on the
 * lane's zone, just as a held bongo key stays armed while any of its bound
 * keys is still pressed.
 *
 * Allowed pointer types: `touch`, `pen`, AND `mouse`. The play scene only
 * mounts this layer when `isTouchDevice()` is true, so on a desktop without
 * touch hardware no pointer listeners are attached and the mouse never
 * triggers lane events. On touch laptops / hybrid devices the player can
 * also "tap" with the mouse, which is intentional for in-browser testing.
 *
 * `dispose()` removes every listener AND fires releases for any held lanes
 * so the scoring engine doesn't end up with a permanently-armed sustain.
 *
 * `setEnabled(false)` short-circuits NEW pointerdowns (no presses fire) but
 * still processes pointerup / cancel / leave so any pre-existing held
 * pointer is properly released. Re-enabling does NOT replay missed presses
 * — pointer events are discrete, unlike the gamepad poll, so a press
 * silenced by `enabled=false` is gone.
 */

const STAGE_W = 1280;
const STAGE_H = 720;

/** Bottom-of-stage fraction occupied by the tap zones (0..1). */
export const TAP_ZONE_TOP_FRAC = 0.6;

const ALLOWED_POINTER_TYPES: ReadonlySet<string> = new Set(['touch', 'pen', 'mouse']);

export interface TouchInputOptions {
  /** Element to attach pointer listeners to (typically the canvas). */
  target: EventTarget;
  /**
   * Maps a client (x, y) point to a lane. Return `null` when the point
   * is outside any tap zone — the input layer will then skip the press
   * AND skip `preventDefault()` so the browser handles the gesture
   * (scroll, zoom, etc.) normally.
   */
  hitTest: (clientX: number, clientY: number) => 'L' | 'R' | null;
  onLanePress: (lane: 'L' | 'R') => void;
  onLaneRelease: (lane: 'L' | 'R') => void;
  /** Initial enabled state. Defaults to `true`. */
  enabled?: boolean;
}

export interface TouchInputHandle {
  /** Detach all listeners and release any held lanes. Idempotent. */
  dispose(): void;
  /** Suppress new pointerdowns. Held pointers can still release on up. */
  setEnabled(v: boolean): void;
}

/**
 * Heuristic: returns true when the runtime exposes touch capability. Used
 * by the play / tutorial scenes to decide whether to render the on-screen
 * tap zones AND wire the touch input layer at all. In a Node test
 * environment (no `window`, no `navigator`) this returns `false`.
 */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  if ('ontouchstart' in window) return true;
  if (typeof navigator !== 'undefined' && typeof navigator.maxTouchPoints === 'number') {
    return navigator.maxTouchPoints > 0;
  }
  return false;
}

/**
 * Build a hitTest closure for the given canvas. Maps viewport coordinates
 * to the canvas's logical (1280×720) coordinate space, accounting for
 * - CSS scaling (canvas may be displayed smaller / larger than 1280×720),
 * - portrait rotation (when `body.bh-portrait` is set, the canvas is
 *   CSS-rotated 90° clockwise; viewport coords are un-rotated to
 *   canvas-local space before the lane decision).
 *
 * Returns `null` when the point is outside the canvas bounding box OR
 * outside the bottom-`TAP_ZONE_TOP_FRAC` band of the canvas. Otherwise
 * returns `'L'` for the left half, `'R'` for the right.
 */
export function makeCanvasHitTest(
  canvas: HTMLCanvasElement,
): (clientX: number, clientY: number) => 'L' | 'R' | null {
  return (clientX: number, clientY: number): 'L' | 'R' | null => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      return null;
    }
    const portrait =
      typeof document !== 'undefined' && document.body.classList.contains('bh-portrait');
    let logicalX: number;
    let logicalY: number;
    if (portrait) {
      // The canvas is CSS-rotated 90° clockwise via the `.bh-portrait`
      // rule on body. To recover canvas-local coords from a viewport
      // point we un-rotate by -90°: in normalised bounding-box space,
      // bbX (left→right) maps to canvas Y (bottom→top) and bbY
      // (top→bottom) maps to canvas X (left→right).
      const normX = (clientX - rect.left) / rect.width;
      const normY = (clientY - rect.top) / rect.height;
      logicalX = normY * STAGE_W;
      logicalY = (1 - normX) * STAGE_H;
    } else {
      logicalX = ((clientX - rect.left) / rect.width) * STAGE_W;
      logicalY = ((clientY - rect.top) / rect.height) * STAGE_H;
    }
    if (logicalY < STAGE_H * TAP_ZONE_TOP_FRAC) return null;
    return logicalX < STAGE_W / 2 ? 'L' : 'R';
  };
}

interface CancelablePointerEvent {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  preventDefault?: () => void;
}

export function startTouchInput(opts: TouchInputOptions): TouchInputHandle {
  const target = opts.target;
  let disposed = false;
  let enabledFlag = opts.enabled !== false;

  const pointerLane = new Map<number, 'L' | 'R'>();
  let leftCount = 0;
  let rightCount = 0;

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

  function releaseAllHeld(): void {
    if (pointerLane.size === 0) return;
    for (const lane of pointerLane.values()) {
      bumpLane(lane, -1);
    }
    pointerLane.clear();
  }

  const handleDown: EventListener = (raw) => {
    if (!enabledFlag) return;
    const ev = raw as unknown as CancelablePointerEvent;
    if (!ALLOWED_POINTER_TYPES.has(ev.pointerType)) return;
    if (pointerLane.has(ev.pointerId)) return;
    const lane = opts.hitTest(ev.clientX, ev.clientY);
    if (lane === null) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    pointerLane.set(ev.pointerId, lane);
    bumpLane(lane, 1);
  };

  const handleUp: EventListener = (raw) => {
    const ev = raw as unknown as CancelablePointerEvent;
    const lane = pointerLane.get(ev.pointerId);
    if (lane === undefined) return;
    pointerLane.delete(ev.pointerId);
    bumpLane(lane, -1);
  };

  const handleCancel: EventListener = (raw) => {
    const ev = raw as unknown as CancelablePointerEvent;
    const lane = pointerLane.get(ev.pointerId);
    if (lane === undefined) return;
    pointerLane.delete(ev.pointerId);
    bumpLane(lane, -1);
  };

  // pointerleave: pointer left the target's bounding region. We treat that
  // as a release because the player likely lifted their finger or dragged
  // off the canvas — leaving the lane stuck on would silently fail any
  // pending sustain.
  const handleLeave: EventListener = (raw) => {
    const ev = raw as unknown as CancelablePointerEvent;
    const lane = pointerLane.get(ev.pointerId);
    if (lane === undefined) return;
    pointerLane.delete(ev.pointerId);
    bumpLane(lane, -1);
  };

  target.addEventListener('pointerdown', handleDown);
  target.addEventListener('pointerup', handleUp);
  target.addEventListener('pointercancel', handleCancel);
  target.addEventListener('pointerleave', handleLeave);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      target.removeEventListener('pointerdown', handleDown);
      target.removeEventListener('pointerup', handleUp);
      target.removeEventListener('pointercancel', handleCancel);
      target.removeEventListener('pointerleave', handleLeave);
      releaseAllHeld();
    },
    setEnabled(v: boolean): void {
      enabledFlag = v;
    },
  };
}

/**
 * Create the two on-screen tap-zone DOM elements used as a visual hint on
 * touch devices. The zones are pointer-events:none — actual hit-testing is
 * done by the touch input layer against the canvas itself, which keeps the
 * input semantics independent of where the visual hints land.
 *
 * Returns the inserted root + a `dispose()` that removes both hints. The
 * caller (play / tutorial scene) owns lifecycle and calls `dispose` from
 * `exit()`.
 */
export interface TouchZoneHandle {
  dispose(): void;
}

export function mountTouchZones(overlay: HTMLElement): TouchZoneHandle {
  if (typeof document === 'undefined') return { dispose: () => undefined };
  const left = document.createElement('div');
  left.className = 'bh-touch-zone bh-touch-zone-l';
  left.setAttribute('aria-hidden', 'true');
  left.textContent = 'L';
  const right = document.createElement('div');
  right.className = 'bh-touch-zone bh-touch-zone-r';
  right.setAttribute('aria-hidden', 'true');
  right.textContent = 'R';
  overlay.appendChild(left);
  overlay.appendChild(right);
  return {
    dispose(): void {
      left.remove();
      right.remove();
    },
  };
}
