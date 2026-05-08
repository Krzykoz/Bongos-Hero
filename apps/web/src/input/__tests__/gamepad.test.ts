import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startGamepadInput, type GamepadInputHandle } from '../gamepad.js';

/**
 * Minimal Gamepad-shaped stub. We only touch `.buttons[i].pressed` and the
 * outer index from `getGamepads()`, so the rest of the Gamepad API is left
 * unimplemented to keep these tests focused on edge-detection behaviour.
 */
interface FakeButton {
  pressed: boolean;
}
interface FakeGamepad {
  index: number;
  buttons: FakeButton[];
}

let mockedGamepads: (FakeGamepad | null)[] = [];
let rafQueue: FrameRequestCallback[] = [];
let rafIdCounter = 0;
let cancelledIds: number[] = [];
let connectListener: EventListener | null = null;
let disconnectListener: EventListener | null = null;
let removedConnect: EventListener | null = null;
let removedDisconnect: EventListener | null = null;

function makePad(buttons: boolean[], index = 0): FakeGamepad {
  return { index, buttons: buttons.map((pressed) => ({ pressed })) };
}

/**
 * Drain the rAF queue once, simulating a single frame tick. The poller
 * always re-schedules itself before returning, so the new callback lands in
 * `rafQueue` for the NEXT call to `tickFrame()`.
 */
function tickFrame(): void {
  const cb = rafQueue.shift();
  if (cb) cb(performance.now());
}

beforeEach(() => {
  mockedGamepads = [];
  rafQueue = [];
  rafIdCounter = 0;
  cancelledIds = [];
  connectListener = null;
  disconnectListener = null;
  removedConnect = null;
  removedDisconnect = null;

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafQueue.push(cb);
    rafIdCounter += 1;
    return rafIdCounter;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    cancelledIds.push(id);
  });
  vi.stubGlobal('navigator', {
    getGamepads: (): (FakeGamepad | null)[] => mockedGamepads,
  });
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: EventListener): void => {
      if (type === 'gamepadconnected') connectListener = listener;
      else if (type === 'gamepaddisconnected') disconnectListener = listener;
    },
    removeEventListener: (type: string, listener: EventListener): void => {
      if (type === 'gamepadconnected') removedConnect = listener;
      else if (type === 'gamepaddisconnected') removedDisconnect = listener;
    },
    requestAnimationFrame: (cb: FrameRequestCallback): number => {
      rafQueue.push(cb);
      rafIdCounter += 1;
      return rafIdCounter;
    },
    cancelAnimationFrame: (id: number): void => {
      cancelledIds.push(id);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startGamepadInput edge detection', () => {
  it('fires onLanePress once when a button transitions false → true', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    let handle: GamepadInputHandle | null = null;
    try {
      handle = startGamepadInput({ onLanePress, onLaneRelease });

      // Frame 1: button 4 not pressed → no fire.
      mockedGamepads = [makePad([false, false, false, false, false, false])];
      tickFrame();
      expect(onLanePress).not.toHaveBeenCalled();

      // Frame 2: button 4 pressed → press edge.
      mockedGamepads = [makePad([false, false, false, false, true, false])];
      tickFrame();
      expect(onLanePress).toHaveBeenCalledTimes(1);
      expect(onLanePress).toHaveBeenCalledWith('L');
      expect(onLaneRelease).not.toHaveBeenCalled();
    } finally {
      handle?.dispose();
    }
  });

  it('fires onLaneRelease once when a button transitions true → false', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    const handle = startGamepadInput({ onLanePress, onLaneRelease });
    try {
      // Frame 1: button 5 pressed → press R.
      mockedGamepads = [makePad([false, false, false, false, false, true])];
      tickFrame();
      expect(onLanePress).toHaveBeenCalledWith('R');

      // Frame 2: button 5 released → release R.
      mockedGamepads = [makePad([false, false, false, false, false, false])];
      tickFrame();
      expect(onLaneRelease).toHaveBeenCalledTimes(1);
      expect(onLaneRelease).toHaveBeenCalledWith('R');
    } finally {
      handle.dispose();
    }
  });

  it('does NOT fire on a sustained press (true → true emits no event)', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    const handle = startGamepadInput({ onLanePress, onLaneRelease });
    try {
      mockedGamepads = [makePad([false, false, false, false, true, false])];
      tickFrame();
      expect(onLanePress).toHaveBeenCalledTimes(1);

      // Held across multiple frames — no further press / release.
      tickFrame();
      tickFrame();
      tickFrame();
      expect(onLanePress).toHaveBeenCalledTimes(1);
      expect(onLaneRelease).not.toHaveBeenCalled();
    } finally {
      handle.dispose();
    }
  });

  it('fires release on disconnect for any held buttons', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    const handle = startGamepadInput({ onLanePress, onLaneRelease });
    try {
      // Press both bumpers on the same gamepad.
      mockedGamepads = [makePad([false, false, false, false, true, true])];
      tickFrame();
      expect(onLanePress).toHaveBeenCalledWith('L');
      expect(onLanePress).toHaveBeenCalledWith('R');
      expect(onLanePress).toHaveBeenCalledTimes(2);

      // Disconnect mid-press: getGamepads() now returns [null].
      mockedGamepads = [null];
      tickFrame();
      expect(onLaneRelease).toHaveBeenCalledTimes(2);
      expect(onLaneRelease).toHaveBeenCalledWith('L');
      expect(onLaneRelease).toHaveBeenCalledWith('R');
    } finally {
      handle.dispose();
    }
  });

  it('dispose() removes all listeners — no fires after a press+release cycle', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    const handle = startGamepadInput({ onLanePress, onLaneRelease });

    // First frame fires normally.
    mockedGamepads = [makePad([false, false, false, false, true, false])];
    tickFrame();
    expect(onLanePress).toHaveBeenCalledTimes(1);
    onLanePress.mockClear();
    onLaneRelease.mockClear();

    handle.dispose();
    expect(cancelledIds.length).toBeGreaterThan(0);
    expect(removedConnect).toBe(connectListener);
    expect(removedDisconnect).toBe(disconnectListener);

    // After dispose, even though we mutate the mocked gamepads to simulate a
    // press + release cycle, no poll runs (rAF was cancelled, no new tick is
    // ever scheduled), so neither callback fires.
    mockedGamepads = [makePad([false, false, false, false, false, false])];
    tickFrame();
    mockedGamepads = [makePad([false, false, false, false, true, false])];
    tickFrame();
    mockedGamepads = [makePad([false, false, false, false, false, false])];
    tickFrame();

    expect(onLanePress).not.toHaveBeenCalled();
    expect(onLaneRelease).not.toHaveBeenCalled();
  });

  it('buttonMap override: { 0: "L" } makes button 0 fire L', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    const handle = startGamepadInput({
      onLanePress,
      onLaneRelease,
      buttonMap: { 0: 'L' },
    });
    try {
      // Press button 0 — should fire L per the override.
      mockedGamepads = [makePad([true, false, false, false, false, false])];
      tickFrame();
      expect(onLanePress).toHaveBeenCalledTimes(1);
      expect(onLanePress).toHaveBeenCalledWith('L');

      // Release.
      mockedGamepads = [makePad([false, false, false, false, false, false])];
      tickFrame();
      expect(onLaneRelease).toHaveBeenCalledWith('L');
    } finally {
      handle.dispose();
    }
  });

  it('skips null / undefined gamepads in the array without throwing', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    const handle = startGamepadInput({ onLanePress, onLaneRelease });
    try {
      // Index 0 is null (some browsers return null slots for hot-plug churn);
      // index 1 is a real pad with bumper L pressed.
      mockedGamepads = [null, makePad([false, false, false, false, true, false], 1)];
      expect(() => {
        tickFrame();
      }).not.toThrow();
      expect(onLanePress).toHaveBeenCalledWith('L');

      // All-null array shouldn't throw either.
      mockedGamepads = [null, null];
      expect(() => {
        tickFrame();
      }).not.toThrow();
      // The previously-held button vanishes with its gamepad → release fires.
      expect(onLaneRelease).toHaveBeenCalledWith('L');
    } finally {
      handle.dispose();
    }
  });
});

describe('startGamepadInput lane aggregation', () => {
  it('does not double-fire onLanePress when two buttons map to the same lane', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    const handle = startGamepadInput({ onLanePress, onLaneRelease });
    try {
      // Default map: button 0 (A) AND button 4 (LB) both fire L.
      mockedGamepads = [makePad([true, false, false, false, false, false])];
      tickFrame();
      expect(onLanePress).toHaveBeenCalledTimes(1);
      expect(onLanePress).toHaveBeenCalledWith('L');

      // Add the second L-mapped button — refcount goes 1 → 2; no new edge.
      mockedGamepads = [makePad([true, false, false, false, true, false])];
      tickFrame();
      expect(onLanePress).toHaveBeenCalledTimes(1);

      // Release one — refcount 2 → 1; still no release edge.
      mockedGamepads = [makePad([true, false, false, false, false, false])];
      tickFrame();
      expect(onLaneRelease).not.toHaveBeenCalled();

      // Release the other — refcount 1 → 0; release fires.
      mockedGamepads = [makePad([false, false, false, false, false, false])];
      tickFrame();
      expect(onLaneRelease).toHaveBeenCalledTimes(1);
      expect(onLaneRelease).toHaveBeenCalledWith('L');
    } finally {
      handle.dispose();
    }
  });

  it('respects setEnabled(false) — no edges detected while disabled', () => {
    const onLanePress = vi.fn();
    const onLaneRelease = vi.fn();
    const handle = startGamepadInput({ onLanePress, onLaneRelease });
    try {
      handle.setEnabled(false);

      // Press while disabled — no fire.
      mockedGamepads = [makePad([false, false, false, false, true, false])];
      tickFrame();
      expect(onLanePress).not.toHaveBeenCalled();

      // Re-enable. The button is still pressed; the press edge is detected
      // on the first enabled poll.
      handle.setEnabled(true);
      tickFrame();
      expect(onLanePress).toHaveBeenCalledWith('L');
    } finally {
      handle.dispose();
    }
  });
});
