/**
 * Standalone demo entry-point for the highway renderer.
 *
 * NOT auto-imported anywhere — this file exists so a human (or the next
 * agent) can wire it up to a `<canvas>` and visually inspect the highway
 * without the rest of the game running.
 *
 * Example usage:
 *
 *     import { runHighwayDemo } from './render/__demo__.js';
 *     const cancel = runHighwayDemo(document.querySelector('canvas')!);
 *     // ...later...
 *     cancel();
 */

import { HighwayRenderer, type HighwayRenderState } from './highway.js';

/**
 * Drives the `HighwayRenderer` on `canvas` with synthetic input:
 *  - left and right "press" toggle every 0.5 s (out of phase),
 *  - star-power toggles every 3 s,
 *  - beat-pulse follows a fake 120 BPM sine wave.
 *
 * Returns a function that cancels the rAF loop.
 */
export function runHighwayDemo(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('runHighwayDemo: 2D context unavailable');
  }

  const renderer = new HighwayRenderer();
  const state: HighwayRenderState = {
    pressed: { L: false, R: false },
    starPowerActive: false,
    beatPulse: 0,
  };

  let rafId = 0;
  let startMs = 0;

  const frame = (nowMs: number): void => {
    if (startMs === 0) startMs = nowMs;
    const t = (nowMs - startMs) / 1000;

    state.pressed.L = Math.floor(t / 0.5) % 2 === 0;
    state.pressed.R = Math.floor(t / 0.5) % 2 === 1;
    state.starPowerActive = Math.floor(t / 3) % 2 === 1;
    state.beatPulse = Math.max(0, Math.sin(t * Math.PI * 2 * 2));

    renderer.draw(ctx, state);
    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  return (): void => {
    cancelAnimationFrame(rafId);
  };
}
