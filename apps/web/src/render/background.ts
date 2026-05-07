/**
 * Animated PS2 Guitar-Hero–style background.
 *
 * Drawn behind the highway every frame: a violet sky/back-wall, a static
 * stage rig with three colored spot beams, three silhouetted band members
 * bobbing on the beat, and a two-layer parallax crowd that hops on every
 * downbeat.
 *
 * All artwork is procedural (no image assets). Per-frame work is dominated
 * by ~80 `drawImage` blits of pre-baked sprites plus three trapezoid fills
 * for the spot beams; nothing in the hot path allocates new objects.
 *
 * Layer order (back → front), matching the conceptual model:
 *   1. Sky / back-wall vertical gradient (cached per ctx)
 *   2. Stage truss + drops (single static sprite, baked at module init)
 *   3. Three colored spot beams (vertical-gradient trapezoids, `screen` blend)
 *   4. Three band silhouettes (head + legs baked, torso + arms dynamic)
 *   5. Parallax crowd, two layers (heads tiled across the screen)
 *
 * The highway renderer draws on top of all of this.
 */

import { HIGHWAY_FAR_Y, STAGE_W } from './geom.js';

// === Layout / palette constants =============================================

/** Bottom of the back-wall band. The crowd lives in the strip below it. */
const BACK_WALL_BOTTOM_Y = HIGHWAY_FAR_Y + 60;

const SKY_TOP = '#1a0e22';
const SKY_BOTTOM = '#2a1238';
const SP_OVERLAY = 'rgba(120, 220, 255, 0.18)';

// Stage truss (horizontal bar + three vertical drops hanging down).
const TRUSS_TOP_Y = 60;
const TRUSS_BAR_HEIGHT = 6;
const TRUSS_DROPS_BOTTOM_Y = 100;
const TRUSS_DROP_HALF_W = 4;
const TRUSS_COLOR = '#2b1c3f';
const TRUSS_BAR_X: readonly number[] = [STAGE_W * 0.2, STAGE_W * 0.5, STAGE_W * 0.8];

// Spotlight beams: three trapezoids fanning down from the truss drops.
const SPOT_TOP_Y = TRUSS_DROPS_BOTTOM_Y;
const SPOT_BOT_Y = HIGHWAY_FAR_Y - 10;
const SPOT_TOP_HALF_W = 14;
const SPOT_BOT_HALF_W = 80;
/** Lateral offset at the bottom of a beam at peak ±10° wobble. */
const SPOT_WOBBLE_AMP_PX = Math.tan((10 * Math.PI) / 180) * (SPOT_BOT_Y - SPOT_TOP_Y);
const SPOT_WOBBLE_PERIOD_MS = 4000;
const SPOT_PHASE_OFFSET = 1.7;
const SPOT_COLORS: readonly [string, string, string] = ['#ff5fb6', '#5fd1ff', '#fff15f'];
/** Beam top opacity. The beam fades to fully transparent at the bottom. */
const SPOT_TOP_ALPHA = 0.55;

// Band silhouettes.
const BAND_SILHOUETTE = '#000000';
const BAND_RIM = '#3a1d4e';
const BAND_RIM_WIDTH = 1.5;

/** Y of the figure's feet (sprite is anchored at bottom-centre). */
const BAND_FEET_Y = HIGHWAY_FAR_Y - 30;

const BAND_DRUMMER_X = STAGE_W * 0.5;
const BAND_GUITAR_X = STAGE_W * 0.5 - 200;
const BAND_BASS_X = STAGE_W * 0.5 + 200;

const BAND_SCALE_DRUMMER = 1.05;
const BAND_SCALE_SIDE = 0.9;

// Sprite local coordinate frame (60×100 nominal silhouette).
const BAND_SPRITE_W = 60;
const BAND_SPRITE_H = 100;
const BAND_HEAD_CX = 30;
const BAND_HEAD_CY = 14;
const BAND_HEAD_RX = 9;
const BAND_HEAD_RY = 11;
const BAND_TORSO_TOP_Y = 24;
const BAND_TORSO_BOTTOM_Y = 62;
const BAND_TORSO_HALF_W = 11;
const BAND_LEG_TOP_Y = 62;
const BAND_LEG_BOTTOM_Y = 95;
const BAND_LEG_OFFSET_X = 5;
const BAND_LEG_HALF_W = 3;
const BAND_SHOULDER_Y = 30;
const BAND_SHOULDER_OFFSET_X = 11;
const BAND_ARM_LEN = 22;
const BAND_ARM_WIDTH = 3.5;

// Bob amplitude and per-figure phase offsets (in beats).
const BAND_BOB_AMPLITUDE_PX = 4;
const BAND_PHASE_DRUMMER = 0;
const BAND_PHASE_GUITAR = 0.25;
const BAND_PHASE_BASS = 0.5;
const BAND_DRUMMER_ARM_AMPLITUDE_RAD = (15 * Math.PI) / 180;

// Parallax crowd: two layers of tiled heads + shoulders.
const CROWD_HOP_AMPLITUDE_PX = 4;

const CROWD_A_HEAD_W = 12;
const CROWD_A_HEAD_H = 14;
const CROWD_A_TILE_W = 26;
const CROWD_A_SPRITE_W = 24;
const CROWD_A_SPRITE_H = 28;
const CROWD_A_BASE_Y = HIGHWAY_FAR_Y + 22;
const CROWD_A_COLOR = '#1a0a23';
const CROWD_A_SCROLL_SPEED = 6; // px/sec

const CROWD_B_HEAD_W = 18;
const CROWD_B_HEAD_H = 20;
const CROWD_B_TILE_W = 38;
const CROWD_B_SPRITE_W = 36;
const CROWD_B_SPRITE_H = 38;
const CROWD_B_BASE_Y = HIGHWAY_FAR_Y + 56;
const CROWD_B_COLOR = '#0e0617';
const CROWD_B_SCROLL_SPEED = 14;

// === Type aliases ==========================================================

type AnyCtx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type BandRole = 'drummer' | 'guitar' | 'bass';

interface BgCache {
  ctx: CanvasRenderingContext2D;
  sky: CanvasGradient;
  beamGradients: readonly [CanvasGradient, CanvasGradient, CanvasGradient];
}

// === Helpers ===============================================================

function createOffscreen(w: number, h: number): { canvas: AnyCanvas; ctx: AnyCtx2D } {
  if ('OffscreenCanvas' in globalThis) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('background: OffscreenCanvas 2D context unavailable');
    }
    return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('background: HTMLCanvasElement 2D context unavailable');
  }
  return { canvas, ctx };
}

/** Return an `rgba(...)` string from a `#rrggbb` colour and an alpha. */
function hexWithAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// === Module-init static sprites ===========================================
//
// All static art lives in offscreen canvases baked once at module load.
// The hot path only `drawImage`s these and never re-paints them.

function buildTrussSprite(): AnyCanvas {
  const { canvas, ctx } = createOffscreen(STAGE_W, TRUSS_DROPS_BOTTOM_Y);
  ctx.fillStyle = TRUSS_COLOR;

  // Horizontal bar.
  ctx.fillRect(0, TRUSS_TOP_Y, STAGE_W, TRUSS_BAR_HEIGHT);

  // Three vertical drops hanging down to TRUSS_DROPS_BOTTOM_Y.
  const dropTop = TRUSS_TOP_Y + TRUSS_BAR_HEIGHT;
  const dropHeight = TRUSS_DROPS_BOTTOM_Y - dropTop;
  for (const cx of TRUSS_BAR_X) {
    ctx.fillRect(cx - TRUSS_DROP_HALF_W, dropTop, TRUSS_DROP_HALF_W * 2, dropHeight);
  }

  return canvas;
}

function buildBandStaticSprite(_role: BandRole): AnyCanvas {
  const { canvas, ctx } = createOffscreen(BAND_SPRITE_W, BAND_SPRITE_H);

  ctx.fillStyle = BAND_SILHOUETTE;
  ctx.strokeStyle = hexWithAlpha(BAND_RIM, 0.55);
  ctx.lineWidth = BAND_RIM_WIDTH;

  // Head (oval).
  ctx.beginPath();
  ctx.ellipse(BAND_HEAD_CX, BAND_HEAD_CY, BAND_HEAD_RX, BAND_HEAD_RY, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Two legs hanging straight down from beneath the torso.
  const lLegX = BAND_HEAD_CX - BAND_LEG_OFFSET_X - BAND_LEG_HALF_W;
  const rLegX = BAND_HEAD_CX + BAND_LEG_OFFSET_X - BAND_LEG_HALF_W;
  const legHeight = BAND_LEG_BOTTOM_Y - BAND_LEG_TOP_Y;
  ctx.fillRect(lLegX, BAND_LEG_TOP_Y, BAND_LEG_HALF_W * 2, legHeight);
  ctx.fillRect(rLegX, BAND_LEG_TOP_Y, BAND_LEG_HALF_W * 2, legHeight);

  return canvas;
}

function buildCrowdHeadSprite(
  spriteW: number,
  spriteH: number,
  headW: number,
  headH: number,
  color: string,
): AnyCanvas {
  const { canvas, ctx } = createOffscreen(spriteW, spriteH);

  const cx = spriteW / 2;
  const headCy = headH / 2 + 1;

  // Head (ellipse).
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(cx, headCy, headW / 2, headH / 2, 0, 0, Math.PI * 2);
  ctx.fill();

  // Neck stub + thin shoulder line.
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  const neckBottom = headCy + headH * 0.55;
  const shoulderY = neckBottom + Math.max(2, headH * 0.18);

  ctx.lineWidth = Math.max(1.5, headH * 0.12);
  ctx.beginPath();
  ctx.moveTo(cx, headCy + headH / 2 - 1);
  ctx.lineTo(cx, neckBottom);
  ctx.stroke();

  ctx.lineWidth = Math.max(2, headH * 0.18);
  ctx.beginPath();
  ctx.moveTo(cx - headW * 0.55, shoulderY);
  ctx.lineTo(cx + headW * 0.55, shoulderY);
  ctx.stroke();

  return canvas;
}

const TRUSS_SPRITE: AnyCanvas = buildTrussSprite();
const BAND_DRUMMER_STATIC: AnyCanvas = buildBandStaticSprite('drummer');
const BAND_GUITAR_STATIC: AnyCanvas = buildBandStaticSprite('guitar');
const BAND_BASS_STATIC: AnyCanvas = buildBandStaticSprite('bass');
const CROWD_A_SPRITE: AnyCanvas = buildCrowdHeadSprite(
  CROWD_A_SPRITE_W,
  CROWD_A_SPRITE_H,
  CROWD_A_HEAD_W,
  CROWD_A_HEAD_H,
  CROWD_A_COLOR,
);
const CROWD_B_SPRITE: AnyCanvas = buildCrowdHeadSprite(
  CROWD_B_SPRITE_W,
  CROWD_B_SPRITE_H,
  CROWD_B_HEAD_W,
  CROWD_B_HEAD_H,
  CROWD_B_COLOR,
);

function makeBeamGrad(ctx: CanvasRenderingContext2D, color: string): CanvasGradient {
  const grad = ctx.createLinearGradient(0, SPOT_TOP_Y, 0, SPOT_BOT_Y);
  grad.addColorStop(0, hexWithAlpha(color, SPOT_TOP_ALPHA));
  grad.addColorStop(1, hexWithAlpha(color, 0));
  return grad;
}

// === Public API ============================================================

export interface BackgroundRendererOptions {
  /** Tempo in BPM. Drives spotlight color cycling and crowd jump frequency. Default 120. */
  bpm?: number;
}

export interface BackgroundRenderState {
  /** Current song time (ms) — used to advance animations. */
  nowMs: number;
  /** 0..1 ramp resetting each beat. If absent, the renderer computes its own. */
  beatPhase?: number;
  /** Whether to tint the back wall with star-power cyan. */
  starPowerActive?: boolean;
}

export class BackgroundRenderer {
  #bpm: number;
  #beatMs: number;
  #cache: BgCache | null = null;

  constructor(opts: BackgroundRendererOptions = {}) {
    this.#bpm = opts.bpm ?? 120;
    this.#beatMs = 60000 / this.#bpm;
  }

  setBpm(bpm: number): void {
    this.#bpm = bpm;
    this.#beatMs = 60000 / bpm;
  }

  /** Compute the renderer's own beat phase (0..1) for a given song time. */
  beatPhase(nowMs: number): number {
    const beatMs = this.#beatMs;
    return (((nowMs % beatMs) + beatMs) % beatMs) / beatMs;
  }

  /** Draw sky + spotlights + band + crowd. Call BEFORE the highway. */
  draw(ctx: CanvasRenderingContext2D, state: BackgroundRenderState): void {
    const cache = this.#getCache(ctx);
    const nowMs = state.nowMs;
    const phase = state.beatPhase ?? this.beatPhase(nowMs);
    const sp = state.starPowerActive === true;

    ctx.save();

    // 1. Sky / back-wall.
    ctx.fillStyle = cache.sky;
    ctx.fillRect(0, 0, STAGE_W, BACK_WALL_BOTTOM_Y);

    if (sp) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = SP_OVERLAY;
      ctx.fillRect(0, 0, STAGE_W, BACK_WALL_BOTTOM_Y);
      ctx.restore();
    }

    // 2. Stage rig truss.
    ctx.drawImage(TRUSS_SPRITE, 0, 0);

    // 3. Spot beams (animated, screen-blended).
    this.#drawSpots(ctx, cache, nowMs);

    // 4. Band silhouettes.
    this.#drawBand(ctx, phase);

    // 5. Parallax crowd.
    this.#drawCrowd(ctx, nowMs, phase);

    ctx.restore();
  }

  // ---- internals ----------------------------------------------------------

  #drawSpots(ctx: CanvasRenderingContext2D, cache: BgCache, nowMs: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // Color rotation advances by one slot every two beats.
    const colorRotation = Math.floor(nowMs / (this.#beatMs * 2));
    const wobbleBase = (2 * Math.PI * nowMs) / SPOT_WOBBLE_PERIOD_MS;
    const grads = cache.beamGradients;

    for (let i = 0; i < TRUSS_BAR_X.length; i++) {
      const cx = TRUSS_BAR_X[i] ?? 0;
      const wobble = Math.sin(wobbleBase + i * SPOT_PHASE_OFFSET) * SPOT_WOBBLE_AMP_PX;

      const topL = cx - SPOT_TOP_HALF_W;
      const topR = cx + SPOT_TOP_HALF_W;
      const botCx = cx + wobble;
      const botL = botCx - SPOT_BOT_HALF_W;
      const botR = botCx + SPOT_BOT_HALF_W;

      const colorIdx = (((i + colorRotation) % 3) + 3) % 3;
      const grad = colorIdx === 0 ? grads[0] : colorIdx === 1 ? grads[1] : grads[2];

      ctx.beginPath();
      ctx.moveTo(topL, SPOT_TOP_Y);
      ctx.lineTo(topR, SPOT_TOP_Y);
      ctx.lineTo(botR, SPOT_BOT_Y);
      ctx.lineTo(botL, SPOT_BOT_Y);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.restore();
  }

  #drawBand(ctx: CanvasRenderingContext2D, beatPhase: number): void {
    // Drummer (centre, slightly larger, on-beat).
    this.#drawBandFigure(
      ctx,
      BAND_DRUMMER_STATIC,
      BAND_DRUMMER_X,
      BAND_FEET_Y,
      BAND_SCALE_DRUMMER,
      BAND_PHASE_DRUMMER,
      beatPhase,
      true,
    );
    // Guitarist (left, +0.25 beat phase).
    this.#drawBandFigure(
      ctx,
      BAND_GUITAR_STATIC,
      BAND_GUITAR_X,
      BAND_FEET_Y,
      BAND_SCALE_SIDE,
      BAND_PHASE_GUITAR,
      beatPhase,
      false,
    );
    // Bassist (right, +0.5 beat phase).
    this.#drawBandFigure(
      ctx,
      BAND_BASS_STATIC,
      BAND_BASS_X,
      BAND_FEET_Y,
      BAND_SCALE_SIDE,
      BAND_PHASE_BASS,
      beatPhase,
      false,
    );
  }

  #drawBandFigure(
    ctx: CanvasRenderingContext2D,
    staticSprite: AnyCanvas,
    figureX: number,
    feetY: number,
    scale: number,
    phaseOffset: number,
    beatPhase: number,
    isDrummer: boolean,
  ): void {
    const drawW = BAND_SPRITE_W * scale;
    const drawH = BAND_SPRITE_H * scale;
    const dx = figureX - drawW / 2;
    const dy = feetY - drawH;

    // Static parts (head + legs + faint rim) in one blit.
    ctx.drawImage(staticSprite, dx, dy, drawW, drawH);

    // Bobbing torso + arms drawn dynamically inside the sprite's local frame.
    const bobAmount = Math.sin((beatPhase + phaseOffset) * Math.PI * 2) * BAND_BOB_AMPLITUDE_PX;

    ctx.save();
    ctx.translate(dx, dy);
    ctx.scale(scale, scale);

    // Torso rectangle.
    ctx.fillStyle = BAND_SILHOUETTE;
    ctx.fillRect(
      BAND_HEAD_CX - BAND_TORSO_HALF_W,
      BAND_TORSO_TOP_Y + bobAmount,
      BAND_TORSO_HALF_W * 2,
      BAND_TORSO_BOTTOM_Y - BAND_TORSO_TOP_Y,
    );

    // Faint purple rim along the top of the torso.
    ctx.strokeStyle = hexWithAlpha(BAND_RIM, 0.45);
    ctx.lineWidth = BAND_RIM_WIDTH;
    ctx.beginPath();
    ctx.moveTo(BAND_HEAD_CX - BAND_TORSO_HALF_W, BAND_TORSO_TOP_Y + bobAmount);
    ctx.lineTo(BAND_HEAD_CX + BAND_TORSO_HALF_W, BAND_TORSO_TOP_Y + bobAmount);
    ctx.stroke();

    // Arms: drummer swings ±15°, others hang still.
    const armSwing = isDrummer
      ? Math.sin(beatPhase * Math.PI * 2) * BAND_DRUMMER_ARM_AMPLITUDE_RAD
      : 0;
    const shoulderY = BAND_SHOULDER_Y + bobAmount;
    this.#drawArm(ctx, BAND_HEAD_CX - BAND_SHOULDER_OFFSET_X, shoulderY, -1, armSwing);
    this.#drawArm(ctx, BAND_HEAD_CX + BAND_SHOULDER_OFFSET_X, shoulderY, +1, -armSwing);

    ctx.restore();
  }

  #drawArm(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    side: number,
    swingRad: number,
  ): void {
    // Rest pose: arm hangs straight down with a slight outward splay.
    const restAngle = Math.PI / 2 + side * 0.18;
    const angle = restAngle + side * swingRad;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle);
    ctx.fillStyle = BAND_SILHOUETTE;
    ctx.fillRect(-BAND_ARM_WIDTH / 2, 0, BAND_ARM_WIDTH, BAND_ARM_LEN);
    ctx.restore();
  }

  #drawCrowd(ctx: CanvasRenderingContext2D, nowMs: number, beatPhase: number): void {
    // Classic GH crowd hop: heads pop up at beat start, fall back smoothly.
    const eased = Math.pow(beatPhase, 0.4);
    const hop = CROWD_HOP_AMPLITUDE_PX * (1 - eased);

    this.#drawCrowdLayer(
      ctx,
      CROWD_A_SPRITE,
      CROWD_A_SPRITE_W,
      CROWD_A_SPRITE_H,
      CROWD_A_TILE_W,
      CROWD_A_BASE_Y - hop,
      nowMs,
      CROWD_A_SCROLL_SPEED,
    );

    this.#drawCrowdLayer(
      ctx,
      CROWD_B_SPRITE,
      CROWD_B_SPRITE_W,
      CROWD_B_SPRITE_H,
      CROWD_B_TILE_W,
      CROWD_B_BASE_Y - hop,
      nowMs,
      CROWD_B_SCROLL_SPEED,
    );
  }

  #drawCrowdLayer(
    ctx: CanvasRenderingContext2D,
    sprite: AnyCanvas,
    spriteW: number,
    spriteH: number,
    tileW: number,
    topY: number,
    nowMs: number,
    speed: number,
  ): void {
    // Wrap horizontally via modulo. `phase` is always in [0, tileW); we
    // start one tile to the left so the leftmost head doesn't pop in.
    const phase = ((((nowMs / 1000) * speed) % tileW) + tileW) % tileW;
    const xStart = -phase - (tileW - spriteW) * 0.5;
    for (let x = xStart; x < STAGE_W; x += tileW) {
      ctx.drawImage(sprite, x, topY, spriteW, spriteH);
    }
  }

  #getCache(ctx: CanvasRenderingContext2D): BgCache {
    if (this.#cache && this.#cache.ctx === ctx) return this.#cache;

    const sky = ctx.createLinearGradient(0, 0, 0, BACK_WALL_BOTTOM_Y);
    sky.addColorStop(0, SKY_TOP);
    sky.addColorStop(1, SKY_BOTTOM);

    const beam0 = makeBeamGrad(ctx, SPOT_COLORS[0]);
    const beam1 = makeBeamGrad(ctx, SPOT_COLORS[1]);
    const beam2 = makeBeamGrad(ctx, SPOT_COLORS[2]);

    const cache: BgCache = {
      ctx,
      sky,
      beamGradients: [beam0, beam1, beam2],
    };
    this.#cache = cache;
    return cache;
  }
}
