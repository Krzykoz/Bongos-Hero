import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isTouchDevice,
  makeCanvasHitTest,
  startTouchInput,
  type TouchInputHandle,
} from '../touch.js';

/**
 * Minimal pointer-event stub. We only touch the fields the touch input
 * layer reads (`pointerId`, `pointerType`, `clientX`, `clientY`,
 * `preventDefault`), so the rest of the PointerEvent shape stays
 * unimplemented to keep these tests focused on edge-detection behaviour.
 */
interface FakePointerEvent {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  /** Recorded so tests can assert preventDefault was (or wasn't) called. */
  preventedDefault: boolean;
}

/**
 * A barebones EventTarget-shaped stub that lets us synchronously fire
 * stored listeners by name. We don't use the global `EventTarget` because
 * dispatching there forces the use of real `Event` instances, which can't
 * carry custom fields like `pointerId` without subclassing — this keeps
 * the test plumbing compact and assertions readable.
 */
interface FakeTarget {
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
  fire: (type: string, ev: FakePointerEvent) => void;
  listenerCount: () => number;
}

function makeTarget(): FakeTarget {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    fire(type, ev) {
      const set = listeners.get(type);
      if (!set) return;
      const wrapped = {
        ...ev,
        preventDefault(): void {
          ev.preventedDefault = true;
        },
      };
      for (const l of set) l(wrapped as unknown as Event);
    },
    listenerCount() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

function pointer(
  pointerId: number,
  clientX: number,
  clientY: number,
  pointerType = 'touch',
): FakePointerEvent {
  return { pointerId, pointerType, clientX, clientY, preventedDefault: false };
}

/** Hit-test that splits the [0, 200] x [0, 200] plane: x<100 => L, else R. */
function hitTest(x: number, _y: number): 'L' | 'R' | null {
  if (x < 0 || x > 200) return null;
  return x < 100 ? 'L' : 'R';
}

describe('startTouchInput edge detection', () => {
  let target: FakeTarget;
  let handle: TouchInputHandle | null;

  beforeEach(() => {
    target = makeTarget();
    handle = null;
  });
  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  it('pointerdown in the left zone fires onLanePress("L")', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    handle = startTouchInput({
      target: target as unknown as EventTarget,
      hitTest,
      onLanePress,
      onLaneRelease,
    });

    const ev = pointer(1, 50, 100);
    target.fire('pointerdown', ev);

    expect(onLanePress).toHaveBeenCalledTimes(1);
    expect(onLanePress).toHaveBeenCalledWith('L');
    expect(onLaneRelease).not.toHaveBeenCalled();
    // Inside a zone => browser default suppressed (so no scroll / zoom).
    expect(ev.preventedDefault).toBe(true);
  });

  it('pointerdown outside any zone fires nothing AND does not preventDefault', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    handle = startTouchInput({
      target: target as unknown as EventTarget,
      hitTest,
      onLanePress,
      onLaneRelease,
    });

    // hitTest returns null for x>200.
    const ev = pointer(1, 999, 100);
    target.fire('pointerdown', ev);

    expect(onLanePress).not.toHaveBeenCalled();
    expect(ev.preventedDefault).toBe(false);
  });

  it('pointerup fires onLaneRelease for the lane that was pressed by that pointerId', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    handle = startTouchInput({
      target: target as unknown as EventTarget,
      hitTest,
      onLanePress,
      onLaneRelease,
    });

    target.fire('pointerdown', pointer(7, 150, 50)); // R
    expect(onLanePress).toHaveBeenCalledWith('R');

    // pointerup with a DIFFERENT id: nothing fires (we never pressed it).
    target.fire('pointerup', pointer(99, 150, 50));
    expect(onLaneRelease).not.toHaveBeenCalled();

    // pointerup with the matching id: release fires for the bound lane.
    target.fire('pointerup', pointer(7, 0, 0));
    expect(onLaneRelease).toHaveBeenCalledTimes(1);
    expect(onLaneRelease).toHaveBeenCalledWith('R');
  });

  it('two fingers on the same zone refcount: release fires only after both lift', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    handle = startTouchInput({
      target: target as unknown as EventTarget,
      hitTest,
      onLanePress,
      onLaneRelease,
    });

    target.fire('pointerdown', pointer(1, 30, 100)); // L
    target.fire('pointerdown', pointer(2, 60, 100)); // L (same zone)
    // Press only fires on the 0 → 1 transition.
    expect(onLanePress).toHaveBeenCalledTimes(1);
    expect(onLanePress).toHaveBeenCalledWith('L');

    // First finger lifts: refcount 2 → 1; no release yet.
    target.fire('pointerup', pointer(1, 30, 100));
    expect(onLaneRelease).not.toHaveBeenCalled();

    // Second finger lifts: refcount 1 → 0; release fires once.
    target.fire('pointerup', pointer(2, 60, 100));
    expect(onLaneRelease).toHaveBeenCalledTimes(1);
    expect(onLaneRelease).toHaveBeenCalledWith('L');
  });

  it('pointercancel emits release', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    handle = startTouchInput({
      target: target as unknown as EventTarget,
      hitTest,
      onLanePress,
      onLaneRelease,
    });

    target.fire('pointerdown', pointer(3, 40, 80)); // L
    expect(onLanePress).toHaveBeenCalledWith('L');

    target.fire('pointercancel', pointer(3, 40, 80));
    expect(onLaneRelease).toHaveBeenCalledTimes(1);
    expect(onLaneRelease).toHaveBeenCalledWith('L');
  });

  it('pointerleave emits release', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    handle = startTouchInput({
      target: target as unknown as EventTarget,
      hitTest,
      onLanePress,
      onLaneRelease,
    });

    target.fire('pointerdown', pointer(4, 160, 80)); // R
    expect(onLanePress).toHaveBeenCalledWith('R');

    target.fire('pointerleave', pointer(4, 160, 80));
    expect(onLaneRelease).toHaveBeenCalledTimes(1);
    expect(onLaneRelease).toHaveBeenCalledWith('R');
  });

  it('setEnabled(false) suppresses new presses; held pointers can still release', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    handle = startTouchInput({
      target: target as unknown as EventTarget,
      hitTest,
      onLanePress,
      onLaneRelease,
    });

    // Press while enabled → fires.
    target.fire('pointerdown', pointer(1, 30, 100));
    expect(onLanePress).toHaveBeenCalledTimes(1);

    // Disable → new pointerdowns are silenced.
    handle.setEnabled(false);
    target.fire('pointerdown', pointer(2, 50, 100));
    expect(onLanePress).toHaveBeenCalledTimes(1);

    // Pre-existing held pointer (id=1) can still release on up.
    target.fire('pointerup', pointer(1, 30, 100));
    expect(onLaneRelease).toHaveBeenCalledTimes(1);
    expect(onLaneRelease).toHaveBeenCalledWith('L');

    // Re-enable → new presses register again.
    handle.setEnabled(true);
    target.fire('pointerdown', pointer(3, 30, 100));
    expect(onLanePress).toHaveBeenCalledTimes(2);
  });

  it('dispose() removes all listeners and releases held lanes; subsequent events fire nothing', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    handle = startTouchInput({
      target: target as unknown as EventTarget,
      hitTest,
      onLanePress,
      onLaneRelease,
    });

    target.fire('pointerdown', pointer(1, 30, 100)); // L
    target.fire('pointerdown', pointer(2, 160, 100)); // R
    expect(onLanePress).toHaveBeenCalledTimes(2);
    onLanePress.mockClear();

    expect(target.listenerCount()).toBeGreaterThan(0);
    handle.dispose();
    handle = null;

    // Dispose released both held lanes.
    expect(onLaneRelease).toHaveBeenCalledTimes(2);
    expect(onLaneRelease).toHaveBeenCalledWith('L');
    expect(onLaneRelease).toHaveBeenCalledWith('R');
    onLaneRelease.mockClear();

    // All listeners are gone; new events can't reach the handler.
    expect(target.listenerCount()).toBe(0);
    target.fire('pointerdown', pointer(3, 30, 100));
    target.fire('pointerup', pointer(3, 30, 100));
    expect(onLanePress).not.toHaveBeenCalled();
    expect(onLaneRelease).not.toHaveBeenCalled();
  });

  it('ignores pointer types outside { touch, pen, mouse }', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    handle = startTouchInput({
      target: target as unknown as EventTarget,
      hitTest,
      onLanePress,
      onLaneRelease,
    });

    target.fire('pointerdown', pointer(1, 30, 100, 'unknown'));
    expect(onLanePress).not.toHaveBeenCalled();
  });

  it('dispose() is idempotent', () => {
    handle = startTouchInput({
      target: target as unknown as EventTarget,
      hitTest,
      onLanePress: vi.fn(),
      onLaneRelease: vi.fn(),
    });
    handle.dispose();
    expect(() => handle?.dispose()).not.toThrow();
    handle = null;
  });
});

describe('isTouchDevice', () => {
  it('returns false in the node test environment (no window)', () => {
    // The vitest config uses environment: 'node' — `window` is not defined.
    expect(typeof globalThis.window).toBe('undefined');
    expect(isTouchDevice()).toBe(false);
  });
});

describe('makeCanvasHitTest', () => {
  /**
   * Build a fake canvas whose `getBoundingClientRect()` returns the given
   * box. `document` and `body.classList` are also stubbed so the helper
   * can read the portrait flag without a real DOM.
   */
  function fakeCanvas(rect: { left: number; top: number; width: number; height: number }) {
    return {
      getBoundingClientRect: () => ({
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        width: rect.width,
        height: rect.height,
        x: rect.left,
        y: rect.top,
        toJSON: () => ({}),
      }),
    } as unknown as HTMLCanvasElement;
  }

  let savedDocument: typeof globalThis.document | undefined;
  beforeEach(() => {
    savedDocument = globalThis.document;
  });
  afterEach(() => {
    if (savedDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      globalThis.document = savedDocument;
    }
  });

  it('landscape: bottom-left of the canvas → L', () => {
    vi.stubGlobal('document', { body: { classList: { contains: () => false } } });
    const canvas = fakeCanvas({ left: 0, top: 0, width: 1280, height: 720 });
    const test = makeCanvasHitTest(canvas);
    expect(test(100, 700)).toBe('L');
    vi.unstubAllGlobals();
  });

  it('landscape: bottom-right of the canvas → R', () => {
    vi.stubGlobal('document', { body: { classList: { contains: () => false } } });
    const canvas = fakeCanvas({ left: 0, top: 0, width: 1280, height: 720 });
    const test = makeCanvasHitTest(canvas);
    expect(test(1100, 700)).toBe('R');
    vi.unstubAllGlobals();
  });

  it('landscape: top of the canvas (above the tap band) → null', () => {
    vi.stubGlobal('document', { body: { classList: { contains: () => false } } });
    const canvas = fakeCanvas({ left: 0, top: 0, width: 1280, height: 720 });
    const test = makeCanvasHitTest(canvas);
    // Tap band starts at logicalY > 720*0.6 = 432. Logical y=200 is above.
    expect(test(100, 200)).toBe(null);
    vi.unstubAllGlobals();
  });

  it('landscape: outside the canvas bounding box → null', () => {
    vi.stubGlobal('document', { body: { classList: { contains: () => false } } });
    const canvas = fakeCanvas({ left: 100, top: 100, width: 800, height: 450 });
    const test = makeCanvasHitTest(canvas);
    expect(test(50, 50)).toBe(null);
    vi.unstubAllGlobals();
  });

  it('portrait: rotation un-rotates client coords correctly (canvas-bottom = viewport-left)', () => {
    vi.stubGlobal('document', { body: { classList: { contains: () => true } } });
    // Canvas pre-rotation 1280x720, displayed un-scaled. After CSS rotate
    // (90° CW), the bounding box is 720x1280 in viewport space.
    // Viewport point at (rect.left + 0, rect.top + 0) = top-left of bb =
    // pre-rotation BOTTOM-left of canvas = logical (0, 720). y > 432 → L.
    const canvas = fakeCanvas({ left: 0, top: 0, width: 720, height: 1280 });
    const test = makeCanvasHitTest(canvas);
    expect(test(0, 0)).toBe('L');

    // bb top-right = pre-rotation TOP-left of canvas = logical (0, 0).
    // Below the tap band (logicalY = 0 < 432) → null.
    expect(test(720, 0)).toBe(null);

    // Bottom-left of bb = pre-rotation BOTTOM-RIGHT = logical (1280, 720). R.
    expect(test(0, 1280)).toBe('R');
    vi.unstubAllGlobals();
  });
});
