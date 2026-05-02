/**
 * Standalone visual demo for the {@link EffectsRenderer}.
 *
 * NOT auto-imported from `main.ts`. Wire this up to a `<canvas>` to eyeball
 * particle bursts, miss flashes + screen shake, combo popups, and the Star
 * Power banner without booting the rest of the game.
 *
 * Example:
 *
 *     import { runEffectsDemo } from './render/__effectsDemo__.js';
 *     const cancel = runEffectsDemo(document.querySelector('canvas')!);
 *     // ...later...
 *     cancel();
 */

import type { Judgment, Lane } from '@bongos-hero/shared';

import { EffectsRenderer } from './effects.js';
import { STAGE_H, STAGE_W } from './geom.js';
import { HighwayRenderer, type HighwayRenderState } from './highway.js';

const HIT_JUDGMENTS: ReadonlyArray<Exclude<Judgment, 'miss'>> = [
  'perfect',
  'great',
  'good',
];
const LANES: ReadonlyArray<Lane> = ['L', 'R'];

/**
 * Runs the rAF loop. Returns a cancel function that stops the loop.
 */
export function runEffectsDemo(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('runEffectsDemo: 2D context unavailable');
  }

  // Lock the backing store to design resolution; CSS scales the element.
  canvas.width = STAGE_W;
  canvas.height = STAGE_H;

  const highway = new HighwayRenderer();
  const highwayState: HighwayRenderState = {
    pressed: { L: false, R: false },
    starPowerActive: false,
    beatPulse: 0,
  };

  const effects = new EffectsRenderer();

  let rafId = 0;
  const startMs = performance.now();
  let nextHitMs = 0;
  let nextMissMs = 1000;
  let nextComboMs = 2000;
  let nextSpMs = 4000;
  let comboCounter = 0;

  const frame = (): void => {
    const nowMs = performance.now() - startMs;

    if (nowMs >= nextHitMs) {
      const lane = LANES[Math.floor(Math.random() * LANES.length)] ?? 'L';
      const judgment =
        HIT_JUDGMENTS[Math.floor(Math.random() * HIT_JUDGMENTS.length)] ??
        'good';
      effects.spawnHit(lane, judgment, nowMs);
      nextHitMs = nowMs + 250;
    }
    if (nowMs >= nextMissMs) {
      const lane = LANES[Math.floor(Math.random() * LANES.length)] ?? 'L';
      effects.spawnMiss(lane, nowMs);
      nextMissMs = nowMs + 3000;
    }
    if (nowMs >= nextComboMs) {
      comboCounter += 50 * Math.floor(Math.random() * 10 + 1);
      effects.spawnComboPopup(comboCounter, nowMs);
      nextComboMs = nowMs + 5000;
    }
    if (nowMs >= nextSpMs) {
      effects.spawnStarPowerActivated(nowMs);
      nextSpMs = nowMs + 8000;
    }

    // Background highway never shakes.
    highway.draw(ctx, highwayState);

    // Highway+notes layer: read shake offset and translate the canvas before
    // drawing. The demo has no notes, but in the real game NotesRenderer
    // would render here, after the translate.
    const shake = effects.shakeOffset(nowMs);
    ctx.save();
    ctx.translate(shake.x, shake.y);
    effects.draw(ctx, { nowMs });
    ctx.restore();

    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  return (): void => {
    cancelAnimationFrame(rafId);
  };
}
