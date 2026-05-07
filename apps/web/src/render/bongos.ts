/**
 * Bongos renderer — draws the two cartoon bongo drums at the bottom of
 * the canvas, one in each lower corner of the play area.
 *
 * Each drum has:
 *   - drop shadow ellipse beneath it,
 *   - wood-tone rim ring (slightly darker on the bottom for depth),
 *   - drumhead oval with a radial gradient (warm brown for L, cream for R,
 *     matching the lane colours in `theme.ts`),
 *   - faint specular highlight near the top-left of the head.
 *
 * Two animation hooks:
 *   - `pressed` flag (drawn into via `BongosRenderState`) — lights up the
 *     drumhead and adds a continuous halo while the player is holding any
 *     key on that side of the keyboard.
 *   - `noteHit(lane, judgment, tMs)` — one-shot 180 ms judgment-tinted
 *     halo + drumhead squash. Called on hit events from the scoring
 *     engine. Misses are NOT animated here (effects.ts owns the miss
 *     flash on the highway).
 *
 * No allocations in the hot draw path: gradients are cached per
 * CanvasRenderingContext2D (rebuilt automatically if the consumer swaps
 * contexts on us).
 */

import type { Judgment, Lane } from '@bongos-hero/shared';

import { STAGE_W } from './geom.js';

// ---- Layout constants -------------------------------------------------------

/** Y of the drumhead centre. Sits just above the progress bar at y=700. */
const DRUM_CY = 605;
/** Horizontal radius of the drumhead oval. */
const DRUM_RX = 90;
/** Vertical radius of the drumhead oval (slightly squashed for perspective). */
const DRUM_RY = 32;
/** Thickness of the wood rim around the drumhead. */
const RIM_THICKNESS = 14;
/** Vertical depth of the side wall (gives a 3D look). */
const SIDE_WALL_DEPTH = 60;

const LEFT_CX = 170;
const RIGHT_CX = STAGE_W - 170;

// ---- Palette (mirrors theme.laneL / laneR) ---------------------------------

const HEAD_L_INNER = '#f4b07a';
const HEAD_L_OUTER = '#a85820';
const HEAD_R_INNER = '#fff1d2';
const HEAD_R_OUTER = '#caa56a';

const RIM_DARK = '#3a1d12';
const RIM_LIGHT = '#704028';
const SHADOW = 'rgba(0,0,0,0.55)';

const HALO_BY_JUDGMENT: Record<Exclude<Judgment, 'miss'>, string> = {
  perfect: 'rgba(196, 121, 255, 0.85)',
  great: 'rgba(120, 220, 255, 0.7)',
  good: 'rgba(255, 200, 120, 0.6)',
};

const PRESSED_HALO_L = 'rgba(255, 168, 98, 0.55)';
const PRESSED_HALO_R = 'rgba(255, 240, 200, 0.55)';

const PULSE_DURATION_MS = 220;
const PULSE_SQUASH = 0.18; // peak vertical squash of the drumhead on hit

// ---- Cached per-ctx gradients ----------------------------------------------

interface GradientCache {
  ctx: CanvasRenderingContext2D;
  headL: CanvasGradient;
  headR: CanvasGradient;
  sideL: CanvasGradient;
  sideR: CanvasGradient;
}

interface PulseState {
  /** Wall-clock ms when the pulse started. */
  startMs: number;
  /** Halo colour for this pulse. */
  color: string;
}

export interface BongosRenderState {
  nowMs: number;
  pressed: { L: boolean; R: boolean };
}

export class BongosRenderer {
  #cache: GradientCache | null = null;
  #pulseL: PulseState | null = null;
  #pulseR: PulseState | null = null;

  /**
   * Trigger a one-shot pulse on the given drum. Misses are ignored
   * (effects.ts handles miss feedback on the highway).
   */
  noteHit(lane: Lane, judgment: Judgment, tMs: number): void {
    if (judgment === 'miss') return;
    const color = HALO_BY_JUDGMENT[judgment];
    const pulse: PulseState = { startMs: tMs, color };
    if (lane === 'L') this.#pulseL = pulse;
    else this.#pulseR = pulse;
  }

  draw(ctx: CanvasRenderingContext2D, state: BongosRenderState): void {
    const cache = this.#getCache(ctx);
    const { nowMs, pressed } = state;

    ctx.save();

    // Draw left first, then right. Order doesn't really matter — they don't
    // overlap — but keeps the logic mirror-symmetric for any future layout.
    this.#drawDrum(
      ctx,
      LEFT_CX,
      cache.headL,
      cache.sideL,
      pressed.L,
      this.#pulseL,
      nowMs,
      PRESSED_HALO_L,
    );
    this.#drawDrum(
      ctx,
      RIGHT_CX,
      cache.headR,
      cache.sideR,
      pressed.R,
      this.#pulseR,
      nowMs,
      PRESSED_HALO_R,
    );

    ctx.restore();

    // Drop expired pulses so they don't leak.
    if (this.#pulseL && nowMs - this.#pulseL.startMs > PULSE_DURATION_MS) {
      this.#pulseL = null;
    }
    if (this.#pulseR && nowMs - this.#pulseR.startMs > PULSE_DURATION_MS) {
      this.#pulseR = null;
    }
  }

  // ---- internals ------------------------------------------------------------

  #drawDrum(
    ctx: CanvasRenderingContext2D,
    cx: number,
    headGrad: CanvasGradient,
    sideGrad: CanvasGradient,
    pressed: boolean,
    pulse: PulseState | null,
    nowMs: number,
    pressedHalo: string,
  ): void {
    // Pulse progress ∈ [0, 1] (0 = just hit, 1 = expired).
    const pulseAge = pulse ? Math.max(0, nowMs - pulse.startMs) : Infinity;
    const pulseT = Math.min(1, pulseAge / PULSE_DURATION_MS);
    const pulseAlive = pulseT < 1;

    // Drumhead squash on hit: bigger ry briefly, then springs back.
    const squash = pulseAlive ? Math.sin(pulseT * Math.PI) * PULSE_SQUASH : 0;
    const ry = DRUM_RY * (1 + squash);
    const rx = DRUM_RX * (1 - squash * 0.4);

    // 1. Soft drop shadow on the canvas behind the drum.
    ctx.fillStyle = SHADOW;
    ctx.beginPath();
    ctx.ellipse(cx + 6, DRUM_CY + SIDE_WALL_DEPTH + 12, rx + 8, 14, 0, 0, Math.PI * 2);
    ctx.fill();

    // 2. One-shot judgment halo (radial, fades + grows).
    if (pulseAlive && pulse) {
      const haloR = (rx + RIM_THICKNESS) * (1 + 0.6 * pulseT);
      const haloAlpha = 0.85 * (1 - pulseT);
      ctx.save();
      const halo = ctx.createRadialGradient(cx, DRUM_CY, rx * 0.4, cx, DRUM_CY, haloR);
      halo.addColorStop(0, pulse.color);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = haloAlpha;
      ctx.fillStyle = halo;
      ctx.fillRect(cx - haloR, DRUM_CY - haloR, haloR * 2, haloR * 2);
      ctx.restore();
    }

    // 3. Continuous pressed halo (subtler, behind the drum).
    if (pressed) {
      const haloR = (rx + RIM_THICKNESS) * 1.55;
      const halo = ctx.createRadialGradient(cx, DRUM_CY, rx * 0.6, cx, DRUM_CY, haloR);
      halo.addColorStop(0, pressedHalo);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(cx - haloR, DRUM_CY - haloR, haloR * 2, haloR * 2);
    }

    // 4. Side wall (rectangle with curved bottom = body of the drum).
    ctx.beginPath();
    ctx.moveTo(cx - rx - RIM_THICKNESS, DRUM_CY);
    ctx.lineTo(cx - rx - RIM_THICKNESS, DRUM_CY + SIDE_WALL_DEPTH);
    ctx.ellipse(cx, DRUM_CY + SIDE_WALL_DEPTH, rx + RIM_THICKNESS, ry, 0, Math.PI, 0, true);
    ctx.lineTo(cx + rx + RIM_THICKNESS, DRUM_CY);
    ctx.closePath();
    ctx.fillStyle = sideGrad;
    ctx.fill();

    // 5. Wood rim ring.
    ctx.beginPath();
    ctx.ellipse(cx, DRUM_CY, rx + RIM_THICKNESS, ry + RIM_THICKNESS * 0.45, 0, 0, Math.PI * 2);
    ctx.fillStyle = RIM_DARK;
    ctx.fill();

    // Rim inner highlight (top-left arc).
    ctx.strokeStyle = RIM_LIGHT;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(
      cx,
      DRUM_CY,
      rx + RIM_THICKNESS - 1,
      ry + RIM_THICKNESS * 0.45 - 1,
      0,
      Math.PI * 1.05,
      Math.PI * 1.85,
    );
    ctx.stroke();

    // 6. Drumhead.
    ctx.beginPath();
    ctx.ellipse(cx, DRUM_CY, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = headGrad;
    ctx.fill();

    // Brighten the drumhead briefly when pressed/hit.
    const flashAlpha = (pressed ? 0.15 : 0) + (pulseAlive ? 0.45 * (1 - pulseT) : 0);
    if (flashAlpha > 0.001) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = flashAlpha;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(cx, DRUM_CY, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 7. Specular highlight (small ellipse top-left of the drumhead).
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = '#fff7e6';
    ctx.beginPath();
    ctx.ellipse(cx - rx * 0.45, DRUM_CY - ry * 0.45, rx * 0.32, ry * 0.28, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  #getCache(ctx: CanvasRenderingContext2D): GradientCache {
    if (this.#cache && this.#cache.ctx === ctx) return this.#cache;

    const headL = ctx.createRadialGradient(
      LEFT_CX - DRUM_RX * 0.3,
      DRUM_CY - DRUM_RY * 0.3,
      4,
      LEFT_CX,
      DRUM_CY,
      DRUM_RX * 1.1,
    );
    headL.addColorStop(0, HEAD_L_INNER);
    headL.addColorStop(1, HEAD_L_OUTER);

    const headR = ctx.createRadialGradient(
      RIGHT_CX - DRUM_RX * 0.3,
      DRUM_CY - DRUM_RY * 0.3,
      4,
      RIGHT_CX,
      DRUM_CY,
      DRUM_RX * 1.1,
    );
    headR.addColorStop(0, HEAD_R_INNER);
    headR.addColorStop(1, HEAD_R_OUTER);

    // Side walls: dark wood gradient running top→bottom.
    const sideL = ctx.createLinearGradient(0, DRUM_CY, 0, DRUM_CY + SIDE_WALL_DEPTH + DRUM_RY);
    sideL.addColorStop(0, '#5a2a14');
    sideL.addColorStop(1, '#1f0c06');

    const sideR = ctx.createLinearGradient(0, DRUM_CY, 0, DRUM_CY + SIDE_WALL_DEPTH + DRUM_RY);
    sideR.addColorStop(0, '#6b4a26');
    sideR.addColorStop(1, '#241608');

    const cache: GradientCache = { ctx, headL, headR, sideL, sideR };
    this.#cache = cache;
    return cache;
  }
}
