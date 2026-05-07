/**
 * Standalone visual demo for the `BackgroundRenderer`.
 *
 * NOT auto-imported anywhere — wire it up to a `<canvas>` to eyeball the
 * sky, truss, spotlights, band silhouettes, and parallax crowd in
 * isolation (no highway, no notes, no audio).
 *
 * Example:
 *
 *     import { runBackgroundDemo } from './render/__bgDemo__.js';
 *     const cancel = runBackgroundDemo(document.querySelector('canvas')!);
 *     // ...later...
 *     cancel();
 */

import { BackgroundRenderer, type BackgroundRenderState } from './background.js';
import { STAGE_H, STAGE_W } from './geom.js';

export function runBackgroundDemo(canvas: HTMLCanvasElement, bpm = 120): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('runBackgroundDemo: 2D context unavailable');
  }

  // Lock the backing store to the design resolution; CSS may scale freely.
  canvas.width = STAGE_W;
  canvas.height = STAGE_H;

  const renderer = new BackgroundRenderer({ bpm });
  const state: BackgroundRenderState = {
    nowMs: 0,
    starPowerActive: false,
  };

  let rafId = 0;
  const startMs = performance.now();

  const frame = (): void => {
    const elapsed = performance.now() - startMs;
    state.nowMs = elapsed;
    // Toggle star-power tint every 4 s.
    state.starPowerActive = Math.floor(elapsed / 4000) % 2 === 1;

    renderer.draw(ctx, state);
    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  return (): void => {
    cancelAnimationFrame(rafId);
  };
}
