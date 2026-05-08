/**
 * Standalone visual demo for the `HudRenderer`.
 *
 * NOT auto-imported from `main.ts`. A human (or the next agent) can wire it
 * up to a `<canvas>` to eyeball the layout, the multiplier ring colours, the
 * combo pulse, the SP-meter shimmer, and the lane key indicators without
 * the rest of the game being live.
 *
 * Example:
 *
 *     import { runHudDemo } from './render/__hudDemo__.js';
 *     const cancel = runHudDemo(document.querySelector('canvas')!);
 *     // ...later...
 *     cancel();
 */

import { STAGE_H, STAGE_W } from './geom.js';
import { HudRenderer, type HudState } from './hud.js';
import { defaultSnapshot, type ScoringSnapshot } from '../game/scoring.js';

const SONG_DURATION_MS = 4 * 60 * 1000;

function baseMultiplier(combo: number): number {
  if (combo >= 30) return 4;
  if (combo >= 20) return 3;
  if (combo >= 10) return 2;
  return 1;
}

export function runHudDemo(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('runHudDemo: 2D context unavailable');
  }

  // Lock the backing store to the design resolution so the demo is self-
  // contained; CSS sizing on the page can scale it however it likes.
  canvas.width = STAGE_W;
  canvas.height = STAGE_H;

  const hud = new HudRenderer();
  const consumed: ReadonlySet<number> = new Set<number>();

  let rafId = 0;
  const startMs = performance.now();

  const frame = (): void => {
    const elapsedMs = performance.now() - startMs;
    const tSec = elapsedMs / 1000;

    // Multiplier band: 1→2→3→4→1 every 1.25s. Use it as a *target* combo so
    // the actual multiplier the snapshot reports lines up with the visual we
    // claim ("multiplier cycles 1→2→3→4 every 1.25s").
    const mulIdx = Math.floor(tSec / 1.25) % 4;
    const targetCombo = mulIdx === 0 ? 0 : mulIdx === 1 ? 10 : mulIdx === 2 ? 20 : 30;

    // Cycling 0→50 every 5s for a livelier combo readout, but only past the
    // first multiplier band — otherwise the badge stays glued at 4×.
    const cycleCombo = Math.floor((tSec % 5) * 10);

    // Blend: use the larger of the two so the badge respects both signals.
    const combo = Math.max(targetCombo, cycleCombo);
    const baseMul = baseMultiplier(combo);

    // SP meter: triangle wave 0→1→0 over 8 s. spActive toggles every 6 s.
    const spPhase = (tSec % 8) / 8;
    const spMeter = spPhase < 0.5 ? spPhase * 2 : (1 - spPhase) * 2;
    const spActive = Math.floor(tSec / 6) % 2 === 1;

    const multiplier = spActive ? baseMul * 2 : baseMul;
    const score = Math.floor(elapsedMs * 1.7);

    // Slow pseudo-random pressed pattern. Two different toggle cadences so the
    // two indicators don't move in lockstep.
    const pressedL = Math.floor(tSec * 1.7) % 2 === 0;
    const pressedR = Math.floor(tSec * 2.3) % 3 === 0;

    const snapshot: ScoringSnapshot = {
      ...defaultSnapshot(),
      score,
      combo,
      maxCombo: combo,
      multiplier,
      spMeter,
      spActive,
      spRemainingMs: spActive ? spMeter * 12_000 : 0,
      consumed,
      rockMeter: spMeter,
    };

    const songTimeMs = elapsedMs % SONG_DURATION_MS;
    const state: HudState = {
      snapshot,
      songTimeMs,
      songDurationMs: SONG_DURATION_MS,
      pressedL,
      pressedR,
      songTitle: 'Bongo Anthem (feat. The Demo Drummer)',
    };

    // Dark backdrop so the HUD is legible without the highway behind it.
    ctx.fillStyle = '#0a0612';
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);

    hud.draw(ctx, state);

    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  return (): void => {
    cancelAnimationFrame(rafId);
  };
}
