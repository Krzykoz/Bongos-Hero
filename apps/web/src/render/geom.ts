/**
 * Pure perspective math for the Bongos Hero "highway" (scrolling fretboard).
 *
 * All exports here are pure, deterministic, side-effect-free, and never touch
 * the Canvas API. They are called many times per frame (once per visible note,
 * potentially per sub-segment of a sustain) so they must avoid allocations and
 * return primitive numbers only.
 */

import type { Lane } from '@bongos-hero/shared';

// ---- Stage / highway constants ----------------------------------------------

export const STAGE_W = 1280;
export const STAGE_H = 720;

/** Y of the spawn line (vanishing-point side of the highway). */
export const HIGHWAY_FAR_Y = 180;
/** Y of the hit line (camera-near side of the highway). */
export const HIGHWAY_NEAR_Y = 600;

/** Half-width of the trapezoid at the spawn line. */
export const HIGHWAY_FAR_HALF_W = 100;
/** Half-width of the trapezoid at the hit line. */
export const HIGHWAY_NEAR_HALF_W = 380;

/** Horizontal centre of the highway (the trapezoid is symmetric). */
export const HIGHWAY_CENTER_X = STAGE_W / 2;

// ---- Perspective curve ------------------------------------------------------

/**
 * Strength of the perspective acceleration. Smaller = more aggressive
 * acceleration near the hit line (notes appear to "fall faster" as they
 * approach the camera). 0.15 was tuned to feel like the GH3 highway.
 */
const PERSPECTIVE_K = 0.15;

/**
 * Precomputed normalisation constants for `progressToY`.
 *
 * The curve is a hyperbolic remap of `progress` into `[0, 1]` that mimics the
 * `1/z` falloff of a true perspective projection, while keeping the endpoints
 * exactly at the spawn / hit line:
 *
 *   z(p) = 1 - p                           // 1 at spawn, 0 at hit
 *   raw(p) = 1 / (k + z(p))                // hyperbolic, monotonic
 *   t(p)   = (raw(p) - raw(0)) / (raw(1) - raw(0))     // normalised to [0,1]
 *   y(p)   = FAR_Y + (NEAR_Y - FAR_Y) * t(p)
 *
 * `RAW_AT_0` and `RAW_AT_1` are the values of `raw` at the endpoints, hoisted
 * to module scope so the per-frame call doesn't recompute them.
 */
const RAW_AT_0 = 1 / (PERSPECTIVE_K + 1); // raw(p=0) -> z=1
const RAW_AT_1 = 1 / PERSPECTIVE_K; // raw(p=1) -> z=0
const RAW_SPAN = RAW_AT_1 - RAW_AT_0;
const Y_SPAN = HIGHWAY_NEAR_Y - HIGHWAY_FAR_Y;

/**
 * Maps `progress` in `[0, 1]` (0 = spawn line, 1 = hit line) to a screen Y.
 *
 * Hot path: must be a single arithmetic expression (no allocations). Values
 * outside `[0, 1]` are allowed and extrapolate smoothly along the same curve
 * — useful for notes that have already passed the hit line or haven't quite
 * spawned yet.
 */
export function progressToY(progress: number): number {
  const z = 1 - progress;
  const raw = 1 / (PERSPECTIVE_K + z);
  const t = (raw - RAW_AT_0) / RAW_SPAN;
  return HIGHWAY_FAR_Y + Y_SPAN * t;
}

/**
 * Inverse of `progressToY`. Used for layout / HUD placement and not called per
 * note per frame, so clarity beats micro-optimisation.
 */
export function yToProgress(y: number): number {
  const t = (y - HIGHWAY_FAR_Y) / Y_SPAN;
  const raw = RAW_AT_0 + t * RAW_SPAN;
  const z = 1 / raw - PERSPECTIVE_K;
  return 1 - z;
}

// ---- Width / lane / scale ---------------------------------------------------

const HALF_W_SPAN = HIGHWAY_NEAR_HALF_W - HIGHWAY_FAR_HALF_W;

/**
 * Half-width of the highway at the given progress.
 *
 * The trapezoid has straight edges in screen space, so the half-width is
 * linear in screen-Y (not in progress). We resolve this by going through
 * `progressToY` once and lerping over the resulting `t_y`.
 */
export function halfWidthAt(progress: number): number {
  const y = progressToY(progress);
  const tY = (y - HIGHWAY_FAR_Y) / Y_SPAN;
  return HIGHWAY_FAR_HALF_W + HALF_W_SPAN * tY;
}

/**
 * X position of the centre of the given lane at the given progress.
 *
 * The two lanes split the trapezoid down the middle, so each lane centre sits
 * at ±halfWidth/2 from the highway centre — i.e. it converges toward
 * `HIGHWAY_CENTER_X` as `progress -> 0`.
 */
export function laneCenterX(lane: Lane, progress: number): number {
  const hw = halfWidthAt(progress);
  const sign = lane === 'L' ? -1 : 1;
  return HIGHWAY_CENTER_X + sign * (hw * 0.5);
}

/**
 * Visual scale of a note at the given progress.
 *
 * Defined as the ratio of the highway's half-width at `progress` over the
 * half-width at the hit line. By construction this is exactly 1.0 at
 * `progress = 1` and `HIGHWAY_FAR_HALF_W / HIGHWAY_NEAR_HALF_W` at
 * `progress = 0` (~0.263 with the current constants).
 */
export function scaleAt(progress: number): number {
  return halfWidthAt(progress) / HIGHWAY_NEAR_HALF_W;
}
