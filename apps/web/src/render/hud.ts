/**
 * HUD overlay renderer for Bongos Hero.
 *
 * Draws everything that lives on top of the highway and notes: the song
 * title, the score readout, the multiplier badge + combo, the Star-Power
 * meter, the bottom key indicators, the song progress bar, and the pause
 * hint. All drawing is via Canvas 2D primitives — no DOM, no images.
 *
 * Per-frame allocations are kept low: the multiplier ring gradients and the
 * static cyan→magenta SP meter gradient are built lazily on first `draw`
 * and cached against their owning context. The active SP rainbow shimmer is
 * recreated each frame because its colour stops depend on `songTimeMs`.
 */

import type { Lane } from '@bongos-hero/shared';

import type { ScoringSnapshot } from '../game/scoring.js';
import { HIGHWAY_NEAR_Y, STAGE_W, laneCenterX } from './geom.js';
import { THEME } from './theme.js';

const TWO_PI = Math.PI * 2;

// ---- Layout constants -------------------------------------------------------

const TITLE_X = 40;
const TITLE_Y = 56;
const TITLE_MAX_W = 480;

const SCORE_CX = STAGE_W / 2;
const SCORE_Y = 90;
const SCORE_LABEL_Y = 125;

const BADGE_CX = STAGE_W - 100;
const BADGE_CY = 90;
const BADGE_R = 56;
const COMBO_LABEL_Y = 162;
const COMBO_NUMBER_Y = 188;

const SP_X = 380;
const SP_Y = 30;
const SP_W = 520;
const SP_H = 20;
const SP_LABEL_Y = 22;

const KEY_W = 72;
const KEY_H = 56;
const KEY_TOP = HIGHWAY_NEAR_Y + 50;

const PROGRESS_X = 60;
const PROGRESS_Y = 700;
const PROGRESS_W = STAGE_W - 120;
const PROGRESS_H = 6;

const PAUSE_HINT_X = STAGE_W - 60;
const PAUSE_HINT_Y = PROGRESS_Y - 18;

// ---- Multiplier ring colour table -------------------------------------------

interface RingColor {
  /** Solid stroke colour for the ring's bright peak. */
  core: string;
  /** Translucent colour for the outer glow falloff. */
  glow: string;
}

const RING_GRAY: RingColor = { core: '#6a6a78', glow: 'rgba(150,150,170,0.45)' };
const RING_TEAL: RingColor = { core: '#3ddcc9', glow: 'rgba(64,224,208,0.65)' };
const RING_CYAN: RingColor = { core: '#39c8ff', glow: 'rgba(56,180,255,0.7)' };
const RING_MAGENTA: RingColor = { core: '#ff5dd2', glow: 'rgba(255,80,210,0.75)' };

/**
 * Lookup keyed by `Math.min(4, multiplier)` (so 8× collapses onto the 4×
 * magenta entry — the oscillating cyan accent for SP-doubled mode is layered
 * on separately by the badge renderer).
 */
function ringColorFor(multiplier: number): RingColor {
  const k = Math.min(4, Math.max(1, multiplier | 0));
  switch (k) {
    case 4:
      return RING_MAGENTA;
    case 3:
      return RING_CYAN;
    case 2:
      return RING_TEAL;
    default:
      return RING_GRAY;
  }
}

// ---- Cached gradient bundle -------------------------------------------------

interface RingGradients {
  m1: CanvasGradient;
  m2: CanvasGradient;
  m3: CanvasGradient;
  m4: CanvasGradient;
}

interface GradientCache {
  ctx: CanvasRenderingContext2D;
  rings: RingGradients;
  spMeterFill: CanvasGradient;
}

function buildRingGradient(ctx: CanvasRenderingContext2D, color: RingColor): CanvasGradient {
  // Centred at origin: caller translates to badge centre before filling.
  // Inner edge transparent, peak colour at the ring radius (~r=56), outer
  // glow falloff back to transparent at r=80.
  const g = ctx.createRadialGradient(0, 0, 40, 0, 0, 80);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.45, color.core);
  g.addColorStop(0.6, color.glow);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  return g;
}

function pickRingGradient(rings: RingGradients, multiplier: number): CanvasGradient {
  const k = Math.min(4, Math.max(1, multiplier | 0));
  switch (k) {
    case 4:
      return rings.m4;
    case 3:
      return rings.m3;
    case 2:
      return rings.m2;
    default:
      return rings.m1;
  }
}

// ---- Pure helpers -----------------------------------------------------------

/**
 * Format a millisecond duration as `M:SS`. Negative or non-finite inputs
 * collapse to `'0:00'`. Minutes are not zero-padded so `'3:07'` reads
 * naturally; seconds always are.
 */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** Trace a rounded-rect path on `ctx`. Caller does `fill` / `stroke`. */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

// ---- Public types -----------------------------------------------------------

export interface HudState {
  snapshot: ScoringSnapshot;
  /** Song time in ms. */
  songTimeMs: number;
  /** Total song duration in ms. */
  songDurationMs: number;
  /** True if F is held (drives the lane indicator pop). */
  pressedL: boolean;
  /** True if J is held. */
  pressedR: boolean;
  /** Optional song title to render in the top-left. */
  songTitle?: string;
  /**
   * Hide the on-screen F/J key caps. Used by the play scene when the
   * BongosRenderer is active, since the drum animations are a stronger
   * lane-press indicator and the caps would just clutter the bottom area.
   */
  hideKeyCaps?: boolean;
}

// ---- Renderer ---------------------------------------------------------------

export class HudRenderer {
  #cache: GradientCache | null = null;

  constructor() {
    // Gradients are lazily built in `draw` so we don't need a ctx at
    // construction time.
  }

  draw(ctx: CanvasRenderingContext2D, state: HudState): void {
    const cache = this.#getCache(ctx);
    const { snapshot, songTimeMs, songDurationMs, pressedL, pressedR } = state;

    ctx.save();

    if (state.songTitle !== undefined && state.songTitle.length > 0) {
      this.#drawSongTitle(ctx, state.songTitle);
    }
    this.#drawScore(ctx, snapshot.score);
    this.#drawMultiplierBadge(ctx, cache, snapshot, songTimeMs);
    this.#drawSpMeter(ctx, cache, snapshot, songTimeMs);
    if (state.hideKeyCaps !== true) {
      this.#drawLaneIndicators(ctx, pressedL, pressedR);
    }
    this.#drawSongProgress(ctx, songTimeMs, songDurationMs);
    this.#drawPauseHint(ctx);

    ctx.restore();
  }

  // ---- Sections -------------------------------------------------------------

  #drawSongTitle(ctx: CanvasRenderingContext2D, title: string): void {
    ctx.font = 'bold 28px serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';

    let display = title;
    if (ctx.measureText(display).width > TITLE_MAX_W) {
      let trimmed = title;
      // Walk back one char at a time until "trimmed…" fits. The leading
      // length>0 guard prevents an infinite loop on absurd font sizes.
      while (trimmed.length > 0 && ctx.measureText(`${trimmed}…`).width > TITLE_MAX_W) {
        trimmed = trimmed.slice(0, -1);
      }
      display = `${trimmed}…`;
    }

    ctx.fillText(display, TITLE_X, TITLE_Y);
  }

  #drawScore(ctx: CanvasRenderingContext2D, score: number): void {
    const safe = Number.isFinite(score) ? Math.max(0, Math.floor(score)) : 0;
    const text = safe.toLocaleString('en-US');

    ctx.font = 'bold 56px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = '#3a1d4e';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 4;
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, SCORE_CX, SCORE_Y);

    // Reset shadow before the small label below (which doesn't want one).
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetY = 0;

    ctx.font = '14px serif';
    ctx.fillStyle = '#a0a0b0';
    ctx.fillText('SCORE', SCORE_CX, SCORE_LABEL_Y);
  }

  #drawMultiplierBadge(
    ctx: CanvasRenderingContext2D,
    cache: GradientCache,
    snapshot: ScoringSnapshot,
    songTimeMs: number,
  ): void {
    const { multiplier, combo } = snapshot;
    const pulse = combo > 0 ? 1.0 + 0.06 * Math.sin((songTimeMs / 120) * TWO_PI) : 1.0;

    ctx.save();
    ctx.translate(BADGE_CX, BADGE_CY);
    ctx.scale(pulse, pulse);

    // Dark filled disc (badge background).
    ctx.fillStyle = '#0e0a18';
    ctx.beginPath();
    ctx.arc(0, 0, BADGE_R, 0, TWO_PI);
    ctx.fill();

    // Glowing ring — fill a square with the cached radial gradient. The
    // gradient has transparent stops on the inside and outside so only the
    // annulus around r≈56 actually paints.
    ctx.fillStyle = pickRingGradient(cache.rings, multiplier);
    ctx.fillRect(-80, -80, 160, 160);

    // SP-doubled (8×) mode: layer the cyan ring on top with an oscillating
    // alpha so the badge appears to flicker between magenta and cyan.
    if (multiplier > 4) {
      const t = 0.5 + 0.5 * Math.sin((songTimeMs / 300) * TWO_PI);
      ctx.globalAlpha = t;
      ctx.fillStyle = cache.rings.m3;
      ctx.fillRect(-80, -80, 160, 160);
      ctx.globalAlpha = 1;
    }

    // Multiplier number, e.g. "4×" / "8×".
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${multiplier}×`, 0, 2);

    ctx.restore();

    // Combo readout (not scaled with the badge pulse).
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if (combo === 0) {
      ctx.font = 'bold 28px serif';
      ctx.fillStyle = '#7a7a8a';
      ctx.fillText('—', BADGE_CX, COMBO_NUMBER_Y);
    } else {
      ctx.font = '12px serif';
      ctx.fillStyle = '#a0a0b0';
      ctx.fillText('COMBO', BADGE_CX, COMBO_LABEL_Y);

      ctx.font = 'bold 28px serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(combo.toString(), BADGE_CX, COMBO_NUMBER_Y);
    }
  }

  #drawSpMeter(
    ctx: CanvasRenderingContext2D,
    cache: GradientCache,
    snapshot: ScoringSnapshot,
    songTimeMs: number,
  ): void {
    const { spMeter, spActive } = snapshot;
    const fillFrac = Math.max(0, Math.min(1, spMeter));
    const fillW = fillFrac * SP_W;
    const radius = SP_H * 0.5;

    // Label.
    ctx.font = '11px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = spActive ? '#ffffff' : '#a0a0b0';
    ctx.fillText('STAR POWER', SP_X + SP_W * 0.5, SP_LABEL_Y);

    // Background trough.
    ctx.fillStyle = 'rgba(20, 14, 36, 0.85)';
    roundedRectPath(ctx, SP_X, SP_Y, SP_W, SP_H, radius);
    ctx.fill();

    if (fillW > 0) {
      ctx.save();
      // Clip to the rounded outline first, then to the filled portion so the
      // gradient remains positioned consistently across the full meter.
      roundedRectPath(ctx, SP_X, SP_Y, SP_W, SP_H, radius);
      ctx.clip();
      ctx.beginPath();
      ctx.rect(SP_X, SP_Y, fillW, SP_H);
      ctx.clip();

      if (spActive) {
        ctx.fillStyle = this.#buildSpRainbow(ctx, songTimeMs);
      } else {
        ctx.fillStyle = cache.spMeterFill;
      }
      ctx.fillRect(SP_X, SP_Y, SP_W, SP_H);

      // Faint diagonal stripe pattern for "energy". Animated by shifting the
      // stripe origin with songTimeMs.
      const stripeStep = 16;
      const stripeOffset = (songTimeMs / 30) % stripeStep;
      ctx.strokeStyle = spActive ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      for (let sx = SP_X - SP_H - stripeOffset; sx < SP_X + SP_W + SP_H; sx += stripeStep) {
        ctx.beginPath();
        ctx.moveTo(sx, SP_Y + SP_H);
        ctx.lineTo(sx + SP_H, SP_Y);
        ctx.stroke();
      }

      ctx.restore();
    }

    // Outline — pulses at 6 Hz when SP is active.
    if (spActive) {
      const pulse = 0.5 + 0.5 * Math.sin((songTimeMs / 1000) * TWO_PI * 6);
      ctx.strokeStyle = `rgba(255,255,255,${(0.4 + 0.5 * pulse).toFixed(3)})`;
      ctx.lineWidth = 2;
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1.5;
    }
    roundedRectPath(ctx, SP_X, SP_Y, SP_W, SP_H, radius);
    ctx.stroke();
  }

  #drawLaneIndicators(ctx: CanvasRenderingContext2D, pressedL: boolean, pressedR: boolean): void {
    this.#drawKeyCap(ctx, 'L', 'F', pressedL);
    this.#drawKeyCap(ctx, 'R', 'J', pressedR);
  }

  #drawKeyCap(ctx: CanvasRenderingContext2D, lane: Lane, letter: string, pressed: boolean): void {
    const cx = laneCenterX(lane, 1);
    const cy = KEY_TOP + KEY_H * 0.5;
    const colors = lane === 'L' ? THEME.laneL : THEME.laneR;
    const scale = pressed ? 1.08 : 1.0;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);

    if (pressed) {
      ctx.fillStyle = colors.fill;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.shadowColor = colors.glow;
      ctx.shadowBlur = 14;
    } else {
      ctx.fillStyle = 'rgba(14,10,24,0.85)';
      ctx.strokeStyle = colors.fill;
      ctx.lineWidth = 2;
      ctx.shadowBlur = 0;
    }
    roundedRectPath(ctx, -KEY_W * 0.5, -KEY_H * 0.5, KEY_W, KEY_H, 8);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.stroke();

    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = pressed ? '#0e0a18' : '#ffffff';
    ctx.fillText(letter, 0, 2);

    ctx.restore();
  }

  #drawSongProgress(
    ctx: CanvasRenderingContext2D,
    songTimeMs: number,
    songDurationMs: number,
  ): void {
    const radius = PROGRESS_H * 0.5;

    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    roundedRectPath(ctx, PROGRESS_X, PROGRESS_Y, PROGRESS_W, PROGRESS_H, radius);
    ctx.fill();

    const frac =
      songDurationMs > 0 && Number.isFinite(songDurationMs)
        ? Math.max(0, Math.min(1, songTimeMs / songDurationMs))
        : 0;
    const fillW = frac * PROGRESS_W;
    if (fillW > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      roundedRectPath(ctx, PROGRESS_X, PROGRESS_Y, fillW, PROGRESS_H, radius);
      ctx.fill();
    }

    ctx.font = '12px serif';
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'alphabetic';

    ctx.textAlign = 'left';
    ctx.fillText(formatTime(songTimeMs), PROGRESS_X, PROGRESS_Y - 6);

    ctx.textAlign = 'right';
    ctx.fillText(formatTime(songDurationMs), PROGRESS_X + PROGRESS_W, PROGRESS_Y - 6);
  }

  #drawPauseHint(ctx: CanvasRenderingContext2D): void {
    ctx.font = '11px serif';
    ctx.fillStyle = '#7a7a8a';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('ESC to pause', PAUSE_HINT_X, PAUSE_HINT_Y);
  }

  // ---- Cache management -----------------------------------------------------

  #getCache(ctx: CanvasRenderingContext2D): GradientCache {
    if (this.#cache && this.#cache.ctx === ctx) return this.#cache;

    const rings: RingGradients = {
      m1: buildRingGradient(ctx, ringColorFor(1)),
      m2: buildRingGradient(ctx, ringColorFor(2)),
      m3: buildRingGradient(ctx, ringColorFor(3)),
      m4: buildRingGradient(ctx, ringColorFor(4)),
    };

    const spMeterFill = ctx.createLinearGradient(SP_X, SP_Y, SP_X + SP_W, SP_Y);
    spMeterFill.addColorStop(0, '#39c8ff');
    spMeterFill.addColorStop(1, '#ff5dd2');

    const cache: GradientCache = { ctx, rings, spMeterFill };
    this.#cache = cache;
    return cache;
  }

  /**
   * Build the SP-active rainbow shimmer. Created per draw because its colour
   * stops phase-shift with `songTimeMs`. The gradient itself is local to the
   * SP meter's screen rect.
   */
  #buildSpRainbow(ctx: CanvasRenderingContext2D, songTimeMs: number): CanvasGradient {
    const grad = ctx.createLinearGradient(SP_X, SP_Y, SP_X + SP_W, SP_Y);
    const shift = (songTimeMs / 1500) % 1;
    const stops = 6;
    for (let i = 0; i <= stops; i++) {
      const stopT = i / stops;
      const hue = ((shift + stopT) * 360) % 360;
      grad.addColorStop(stopT, `hsl(${hue.toFixed(1)}, 90%, 60%)`);
    }
    return grad;
  }
}
