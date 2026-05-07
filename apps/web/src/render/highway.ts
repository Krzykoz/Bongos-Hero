/**
 * Static highway ("fretboard") renderer.
 *
 * Draws the canvas background, the trapezoidal highway, depth-cue fret lines,
 * the hit line, lane "press" glows, and the optional star-power overlay.
 *
 * This file deliberately does NOT render notes — that's the next agent's job.
 * Per-frame allocation is kept to a minimum: all gradients are built on first
 * `draw` and cached. The cache is invalidated automatically if the consumer
 * hands us a different `CanvasRenderingContext2D`.
 */

import type { Lane } from '@bongos-hero/shared';

import {
  HIGHWAY_CENTER_X,
  HIGHWAY_FAR_HALF_W,
  HIGHWAY_FAR_Y,
  HIGHWAY_NEAR_HALF_W,
  HIGHWAY_NEAR_Y,
  STAGE_H,
  STAGE_W,
  halfWidthAt,
  laneCenterX,
  progressToY,
} from './geom.js';
import { THEME } from './theme.js';

export interface HighwayRenderState {
  /** Lane currently held by the player; renders a glow under that lane. */
  pressed: { L: boolean; R: boolean };
  /** When true, paint the star-power overlay on top of the highway. */
  starPowerActive: boolean;
  /** 0..1, used to pulse the lane indicators on beat (driven by background). */
  beatPulse?: number;
  /**
   * When true, the full-stage background gradient is skipped so a layer
   * behind the canvas (e.g. the muted YouTube iframe) shows through. The
   * trapezoid is still filled (semi-opaque) so the highway stays readable.
   */
  transparentBackground?: boolean;
}

/** Internal cache of canvas gradients keyed off the owning context. */
interface GradientCache {
  ctx: CanvasRenderingContext2D;
  bg: CanvasGradient;
  highwayFill: CanvasGradient;
  glowL: CanvasGradient;
  glowR: CanvasGradient;
}

/** Fret line progress positions (depth cues across the highway). */
const FRET_PROGRESSES: readonly number[] = [0.25, 0.5, 0.75];

/** Radius of the lane "press" glow at the hit line. */
const LANE_GLOW_RADIUS = 220;

/** Base height (in px) of the soft hit-line glow strip. */
const HIT_LINE_GLOW_HEIGHT = 16;

export class HighwayRenderer {
  #cache: GradientCache | null = null;

  constructor() {
    // Nothing to do until we have a context. Gradients are lazily built in
    // `draw` so we don't need a ctx at construction time.
  }

  draw(ctx: CanvasRenderingContext2D, state: HighwayRenderState): void {
    const cache = this.#getCache(ctx);

    ctx.save();

    // 1. Background gradient over the entire stage (skipped when a backing
    //    layer like the YouTube iframe should show through).
    if (state.transparentBackground !== true) {
      ctx.fillStyle = cache.bg;
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    }

    // 2. Trapezoidal highway fill.
    ctx.beginPath();
    this.#tracePath(ctx);
    ctx.fillStyle = cache.highwayFill;
    ctx.fill();

    // 3. Outline edges with a fake taper: thin (2px) over the whole outline,
    //    then a thicker (4px) pass on just the near (bottom) edge so the base
    //    visually "weighs" more than the far edge.
    ctx.strokeStyle = THEME.highwayEdge;
    ctx.lineJoin = 'miter';
    ctx.lineWidth = 2;
    ctx.beginPath();
    this.#tracePath(ctx);
    ctx.stroke();

    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(HIGHWAY_CENTER_X - HIGHWAY_NEAR_HALF_W, HIGHWAY_NEAR_Y);
    ctx.lineTo(HIGHWAY_CENTER_X + HIGHWAY_NEAR_HALF_W, HIGHWAY_NEAR_Y);
    ctx.stroke();

    // 4. Centre lane divider (faint vertical line from spawn to hit).
    ctx.strokeStyle = THEME.laneDivider;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(HIGHWAY_CENTER_X, HIGHWAY_FAR_Y);
    ctx.lineTo(HIGHWAY_CENTER_X, HIGHWAY_NEAR_Y);
    ctx.stroke();

    // 5. Horizontal "fret" depth-cue lines.
    ctx.strokeStyle = THEME.highwayLine;
    ctx.lineWidth = 1.5;
    for (const p of FRET_PROGRESSES) {
      const y = progressToY(p);
      const hw = halfWidthAt(p);
      ctx.beginPath();
      ctx.moveTo(HIGHWAY_CENTER_X - hw, y);
      ctx.lineTo(HIGHWAY_CENTER_X + hw, y);
      ctx.stroke();
    }

    // 6. Lane "press" glows. Clip to the trapezoid so the glow doesn't bleed
    //    onto the background, then blit the cached radial gradient at the
    //    hit-line lane centre.
    if (state.pressed.L || state.pressed.R) {
      ctx.save();
      ctx.beginPath();
      this.#tracePath(ctx);
      ctx.clip();

      if (state.pressed.L) {
        this.#drawLaneGlow(ctx, cache.glowL, 'L');
      }
      if (state.pressed.R) {
        this.#drawLaneGlow(ctx, cache.glowR, 'R');
      }
      ctx.restore();
    }

    // 7. Star-power overlay — tints the highway interior using a `screen`
    //    composite so it brightens rather than washes out.
    if (state.starPowerActive) {
      ctx.save();
      ctx.beginPath();
      this.#tracePath(ctx);
      ctx.clip();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = THEME.spOverlay;
      ctx.fillRect(0, HIGHWAY_FAR_Y, STAGE_W, HIGHWAY_NEAR_Y - HIGHWAY_FAR_Y);
      ctx.restore();
    }

    // 8. Hit line: glow strip first (vertically scaled by beat pulse), then
    //    the sharp 2px line on top.
    const beatPulse = state.beatPulse ?? 0;
    const glowHeight = HIT_LINE_GLOW_HEIGHT * (1 + 0.15 * beatPulse);
    const hitY = progressToY(1);
    const nearLeft = HIGHWAY_CENTER_X - HIGHWAY_NEAR_HALF_W;
    const nearRight = HIGHWAY_CENTER_X + HIGHWAY_NEAR_HALF_W;

    ctx.fillStyle = THEME.hitLineGlow;
    ctx.fillRect(nearLeft, hitY - glowHeight * 0.5, nearRight - nearLeft, glowHeight);

    ctx.strokeStyle = THEME.hitLine;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nearLeft, hitY);
    ctx.lineTo(nearRight, hitY);
    ctx.stroke();

    ctx.restore();
  }

  // ---- internals ------------------------------------------------------------

  /**
   * Trace the trapezoid outline as a closed path on `ctx`. Caller is
   * responsible for `beginPath()` before and `fill`/`stroke`/`clip` after.
   */
  #tracePath(ctx: CanvasRenderingContext2D): void {
    ctx.moveTo(HIGHWAY_CENTER_X - HIGHWAY_FAR_HALF_W, HIGHWAY_FAR_Y);
    ctx.lineTo(HIGHWAY_CENTER_X + HIGHWAY_FAR_HALF_W, HIGHWAY_FAR_Y);
    ctx.lineTo(HIGHWAY_CENTER_X + HIGHWAY_NEAR_HALF_W, HIGHWAY_NEAR_Y);
    ctx.lineTo(HIGHWAY_CENTER_X - HIGHWAY_NEAR_HALF_W, HIGHWAY_NEAR_Y);
    ctx.closePath();
  }

  #drawLaneGlow(ctx: CanvasRenderingContext2D, grad: CanvasGradient, lane: Lane): void {
    const cx = laneCenterX(lane, 1);
    const cy = HIGHWAY_NEAR_Y;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = grad;
    ctx.fillRect(-LANE_GLOW_RADIUS, -LANE_GLOW_RADIUS, LANE_GLOW_RADIUS * 2, LANE_GLOW_RADIUS * 2);
    ctx.restore();
  }

  /**
   * Build (or reuse) the gradient cache for `ctx`. Gradients are tied to a
   * specific `CanvasRenderingContext2D` instance, so we rebuild if the
   * caller swaps contexts on us.
   */
  #getCache(ctx: CanvasRenderingContext2D): GradientCache {
    if (this.#cache && this.#cache.ctx === ctx) {
      return this.#cache;
    }

    const bg = ctx.createLinearGradient(0, 0, 0, STAGE_H);
    bg.addColorStop(0, THEME.bgTop);
    bg.addColorStop(1, THEME.bgBottom);

    const highwayFill = ctx.createLinearGradient(0, HIGHWAY_FAR_Y, 0, HIGHWAY_NEAR_Y);
    highwayFill.addColorStop(0, '#15091e');
    highwayFill.addColorStop(1, '#241038');

    // Lane glows live in their own local coordinate frame (centred on origin)
    // so we can `translate` to the lane's hit-line centre at draw time.
    const glowL = ctx.createRadialGradient(0, 0, 0, 0, 0, LANE_GLOW_RADIUS);
    glowL.addColorStop(0, THEME.laneL.glow);
    glowL.addColorStop(1, 'rgba(0,0,0,0)');

    const glowR = ctx.createRadialGradient(0, 0, 0, 0, 0, LANE_GLOW_RADIUS);
    glowR.addColorStop(0, THEME.laneR.glow);
    glowR.addColorStop(1, 'rgba(0,0,0,0)');

    const cache: GradientCache = { ctx, bg, highwayFill, glowL, glowR };
    this.#cache = cache;
    return cache;
  }
}
