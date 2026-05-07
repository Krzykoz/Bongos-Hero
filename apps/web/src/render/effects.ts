/**
 * Visual effects layer for the Bongos Hero highway.
 *
 * Owns four families of feedback:
 *   1. Hit bursts        — radial particle pop + expanding white "tap ring"
 *      when a note is judged perfect/great/good.
 *   2. Miss flashes      — translucent red rectangle over the failed lane,
 *      coupled with a screen-shake impulse.
 *   3. Combo popups      — large "100", "200", … floating text spawned by the
 *      play scene at score thresholds.
 *   4. Star Power banner — diagonal "STAR POWER!" sweep across the stage when
 *      SP is activated, plus a translucent screen-blended cyan beam.
 *
 * Plus a screen-shake bus: misses push impulses, the play scene reads the
 * current offset every frame and translates the highway+notes layer (NOT the
 * background) before drawing them.
 *
 * ## Allocation discipline
 *
 * Particles live in a fixed-size pool of {@link MAX_PARTICLES} preallocated
 * slots. Spawning recycles the oldest slot if the pool is saturated, so the
 * steady-state frame allocates nothing for particles. Tap rings, miss
 * flashes, shake impulses, the SP banner and combo popups use small fixed-
 * size object arrays (`splice` only when an item dies).
 *
 * The {@link EffectsRenderer.shakeOffset} method returns a single mutable
 * `{ x, y }` instance reused across every call. Callers MUST consume the
 * values immediately and MUST NOT cache the returned object — a later call
 * (including the next frame) will mutate the same fields in place.
 */

import type { Lane, Judgment } from '@bongos-hero/shared';

import { laneCenterX, progressToY, STAGE_H, STAGE_W } from './geom.js';
import { THEME } from './theme.js';

// ---- Tunables ---------------------------------------------------------------

/** Hard ceiling for live particles. ~3 hit bursts of 18 particles fits easily. */
const MAX_PARTICLES = 600;

/** Half-width of the miss-flash rectangle (≈ near half-width / 2). */
const MISS_FLASH_HALF_W = 95;
/** Height of the miss-flash rectangle. */
const MISS_FLASH_H = 80;
/** Lifetime of the miss-flash overlay, in ms. */
const MISS_FLASH_DURATION_MS = 220;

/** Per-miss screen-shake impulse. */
const MISS_SHAKE_AMPLITUDE_PX = 6;
const MISS_SHAKE_DURATION_MS = 200;
/** Total shake magnitude is clamped to this many pixels per axis. */
const MAX_SHAKE_PX = 14;
/** Shake oscillation frequency (Hz). */
const SHAKE_FREQUENCY_HZ = 30;

/** Tap ring (the white "pop" that expands at the hit point). */
const TAP_RING_DURATION_MS = 180;
const TAP_RING_R0 = 12;
const TAP_RING_R1 = 38;
const TAP_RING_ALPHA0 = 0.9;

/** Combo popup keyframes. */
const COMBO_GROW_MS = 120;
const COMBO_HOLD_MS = 350;
const COMBO_FADE_MS = 250;
const COMBO_DRIFT_PX = 40;
const COMBO_BASE_Y = 530;

/** Star-Power banner keyframes (total ~1100 ms). */
const SP_SLIDE_IN_MS = 250;
const SP_HOLD_MS = 600;
const SP_SLIDE_OUT_MS = 250;
const SP_BANNER_H = 120;
const SP_PULSE_HZ = 6;
const SP_PULSE_AMPLITUDE = 0.05;

// ---- Particle pool ----------------------------------------------------------

interface Particle {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bornMs: number;
  lifeMs: number;
  /** Cached `rgb()` body for hot-loop rgba string assembly. */
  colorRgb: string;
}

interface TapRing {
  x: number;
  y: number;
  bornMs: number;
}

interface MissFlash {
  lane: Lane;
  bornMs: number;
}

interface ShakeImpulse {
  amplitude: number;
  startedAtMs: number;
  durationMs: number;
}

interface ComboPopup {
  combo: number;
  bornMs: number;
}

interface StarPowerBanner {
  bornMs: number;
}

// Hit-burst tuning per judgment.
interface HitSpec {
  count: number;
  lifeMs: number;
}
const HIT_SPECS: Record<Exclude<Judgment, 'miss'>, HitSpec> = {
  perfect: { count: 18, lifeMs: 350 },
  great: { count: 12, lifeMs: 350 },
  good: { count: 8, lifeMs: 220 },
};

const SPEED_MIN = 120;
const SPEED_MAX = 280;
const UPWARD_BIAS = 80;
const GRAVITY_PX_S2 = 600;
const DRAG_PER_60HZ_FRAME = 0.94;

// ---- Public surface ---------------------------------------------------------

export interface EffectsState {
  /** Current song time (ms). Used for time-based animation. */
  nowMs: number;
}

/**
 * Renders all post-judgment feedback for the play scene. One instance per
 * canvas. All public methods are safe to call any number of times per frame.
 */
export class EffectsRenderer {
  // Particle pool. `#particles` is fixed-length; `#poolCursor` is the
  // round-robin write head used when every slot is alive.
  readonly #particles: Particle[];
  #poolCursor = 0;

  readonly #tapRings: TapRing[] = [];
  readonly #missFlashes: MissFlash[] = [];
  readonly #shakeImpulses: ShakeImpulse[] = [];
  readonly #comboPopups: ComboPopup[] = [];
  readonly #starBanners: StarPowerBanner[] = [];

  /**
   * Singleton mutable shake-offset return value. See class jsdoc for the
   * caller contract — DO NOT cache this object.
   */
  readonly #shakeOffset: { x: number; y: number } = { x: 0, y: 0 };

  /** `nowMs` from the previous `draw()` call; -1 before the first frame. */
  #lastDrawNowMs = -1;

  constructor() {
    this.#particles = new Array<Particle>(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.#particles[i] = {
        alive: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        bornMs: 0,
        lifeMs: 0,
        colorRgb: '255,255,255',
      };
    }
  }

  // ---- Spawn API ----------------------------------------------------------

  spawnHit(lane: Lane, judgment: Exclude<Judgment, 'miss'>, nowMs: number): void {
    const spec = HIT_SPECS[judgment];
    const cx = laneCenterX(lane, 1);
    const cy = progressToY(1);
    const colorRgb = particleColorRgb(lane, judgment);

    for (let i = 0; i < spec.count; i++) {
      const slot = this.#acquireParticle();
      const angle = Math.random() * Math.PI * 2;
      const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
      slot.alive = true;
      slot.x = cx;
      slot.y = cy;
      slot.vx = Math.cos(angle) * speed;
      slot.vy = Math.sin(angle) * speed - UPWARD_BIAS;
      slot.bornMs = nowMs;
      slot.lifeMs = spec.lifeMs;
      slot.colorRgb = colorRgb;
    }

    this.#tapRings.push({ x: cx, y: cy, bornMs: nowMs });
  }

  spawnMiss(lane: Lane, nowMs: number): void {
    this.#missFlashes.push({ lane, bornMs: nowMs });
    this.#shakeImpulses.push({
      amplitude: MISS_SHAKE_AMPLITUDE_PX,
      startedAtMs: nowMs,
      durationMs: MISS_SHAKE_DURATION_MS,
    });
  }

  spawnComboPopup(combo: number, nowMs: number): void {
    this.#comboPopups.push({ combo, bornMs: nowMs });
  }

  spawnStarPowerActivated(nowMs: number): void {
    this.#starBanners.push({ bornMs: nowMs });
  }

  /**
   * Returns the current screen-shake offset to apply to the world transform.
   *
   * **Caller contract:** the returned object is a singleton mutable instance
   * reused across every call. Read `.x` and `.y` immediately and apply them
   * via `ctx.translate(off.x, off.y)`. Do NOT store the reference — the next
   * call (including the next frame, including the call inside `draw()` for
   * its internal pruning) will mutate these same fields.
   *
   * Renderers should call `ctx.translate(shake.x, shake.y)` before drawing
   * the highway+notes layer so miss-induced shake feels physical. The
   * background should NOT be shaken.
   *
   * Side effect: prunes fully-expired impulses from the active list.
   */
  shakeOffset(nowMs: number): { x: number; y: number } {
    const out = this.#shakeOffset;

    let sumX = 0;
    let sumY = 0;
    const impulses = this.#shakeImpulses;
    let writeIdx = 0;
    for (const imp of impulses) {
      const elapsed = nowMs - imp.startedAtMs;
      if (elapsed >= imp.durationMs || elapsed < 0) continue;

      const decay = 1 - elapsed / imp.durationMs;
      const phase = (2 * Math.PI * SHAKE_FREQUENCY_HZ * elapsed) / 1000;
      sumX += imp.amplitude * decay * Math.sin(phase);
      // Orthogonal-ish vertical component, smaller and out of phase so the
      // motion feels 2D rather than purely horizontal.
      sumY += imp.amplitude * decay * 0.4 * Math.cos(phase * 1.3);

      impulses[writeIdx++] = imp;
    }
    impulses.length = writeIdx;

    if (sumX > MAX_SHAKE_PX) sumX = MAX_SHAKE_PX;
    else if (sumX < -MAX_SHAKE_PX) sumX = -MAX_SHAKE_PX;
    if (sumY > MAX_SHAKE_PX) sumY = MAX_SHAKE_PX;
    else if (sumY < -MAX_SHAKE_PX) sumY = -MAX_SHAKE_PX;

    out.x = sumX;
    out.y = sumY;
    return out;
  }

  /**
   * Update simulation state and draw every live effect. Reads `state.nowMs`
   * for both the time delta (versus the previous draw) and for absolute
   * key-frame math. Wraps the entire draw in `save()`/`restore()` so no
   * canvas state leaks out.
   */
  draw(ctx: CanvasRenderingContext2D, state: EffectsState): void {
    const nowMs = state.nowMs;
    let dtSec = 0;
    if (this.#lastDrawNowMs >= 0) {
      dtSec = (nowMs - this.#lastDrawNowMs) / 1000;
      // Clamp dt to survive paused tabs / huge clock jumps. Negative dt
      // (clock went backwards) is treated as a frame skip — particles hold.
      if (dtSec < 0) dtSec = 0;
      else if (dtSec > 0.05) dtSec = 0.05;
    }
    this.#lastDrawNowMs = nowMs;

    ctx.save();
    this.#updateAndDrawParticles(ctx, dtSec, nowMs);
    this.#drawTapRings(ctx, nowMs);
    this.#drawMissFlashes(ctx, nowMs);
    this.#drawComboPopups(ctx, nowMs);
    this.#drawStarPowerBanners(ctx, nowMs);
    ctx.restore();
  }

  /** Drop every live effect and reset the time delta cursor. */
  clear(): void {
    for (const p of this.#particles) {
      p.alive = false;
    }
    this.#poolCursor = 0;
    this.#tapRings.length = 0;
    this.#missFlashes.length = 0;
    this.#shakeImpulses.length = 0;
    this.#comboPopups.length = 0;
    this.#starBanners.length = 0;
    this.#lastDrawNowMs = -1;
    this.#shakeOffset.x = 0;
    this.#shakeOffset.y = 0;
  }

  // ---- Particle pool internals -------------------------------------------

  /**
   * Returns a particle slot for spawn. Prefers a dead slot; if every slot
   * is alive (extremely heavy spawn rate), recycles the slot at the
   * round-robin cursor — biased toward the oldest particle in the pool.
   */
  #acquireParticle(): Particle {
    const pool = this.#particles;
    const n = pool.length;
    for (let probe = 0; probe < n; probe++) {
      const idx = (this.#poolCursor + probe) % n;
      const slot = pool[idx];
      if (slot !== undefined && !slot.alive) {
        this.#poolCursor = (idx + 1) % n;
        return slot;
      }
    }
    // Pool saturated — recycle the slot at the cursor.
    const idx = this.#poolCursor;
    this.#poolCursor = (idx + 1) % n;
    const slot = pool[idx];
    // Pool is preallocated and never shrunk, so `slot` is always defined;
    // the fallback below keeps the type narrowing honest under
    // `noUncheckedIndexedAccess`.
    if (slot === undefined) {
      const fresh: Particle = {
        alive: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        bornMs: 0,
        lifeMs: 0,
        colorRgb: '255,255,255',
      };
      pool[idx] = fresh;
      return fresh;
    }
    return slot;
  }

  // ---- Per-effect draw passes --------------------------------------------

  #updateAndDrawParticles(ctx: CanvasRenderingContext2D, dtSec: number, nowMs: number): void {
    const pool = this.#particles;
    if (pool.length === 0) return;

    const dragMul = dtSec > 0 ? Math.pow(DRAG_PER_60HZ_FRAME, dtSec * 60) : 1;
    const gravityDelta = GRAVITY_PX_S2 * dtSec;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const p of pool) {
      if (!p.alive) continue;

      const age = nowMs - p.bornMs;
      if (age < 0 || age >= p.lifeMs || p.lifeMs <= 0) {
        p.alive = false;
        continue;
      }

      // Integrate velocity / gravity / drag.
      p.vy += gravityDelta;
      p.vx *= dragMul;
      p.vy *= dragMul;
      p.x += p.vx * dtSec;
      p.y += p.vy * dtSec;

      const lifeT = age / p.lifeMs;
      const alpha = 1 - lifeT;
      const radius = 3 - 2.5 * lifeT;
      if (radius <= 0 || alpha <= 0) continue;

      ctx.fillStyle = `rgba(${p.colorRgb},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  #drawTapRings(ctx: CanvasRenderingContext2D, nowMs: number): void {
    const rings = this.#tapRings;
    if (rings.length === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 2;

    let writeIdx = 0;
    for (const ring of rings) {
      const age = nowMs - ring.bornMs;
      if (age < 0 || age >= TAP_RING_DURATION_MS) continue;

      const t = age / TAP_RING_DURATION_MS;
      const r = TAP_RING_R0 + (TAP_RING_R1 - TAP_RING_R0) * t;
      const alpha = TAP_RING_ALPHA0 * (1 - t);

      ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, r, 0, Math.PI * 2);
      ctx.stroke();

      rings[writeIdx++] = ring;
    }
    rings.length = writeIdx;

    ctx.restore();
  }

  #drawMissFlashes(ctx: CanvasRenderingContext2D, nowMs: number): void {
    const flashes = this.#missFlashes;
    if (flashes.length === 0) return;

    ctx.save();
    const hitY = progressToY(1);

    let writeIdx = 0;
    for (const fl of flashes) {
      const age = nowMs - fl.bornMs;
      if (age < 0 || age >= MISS_FLASH_DURATION_MS) continue;

      const fade = 1 - age / MISS_FLASH_DURATION_MS;
      const cx = laneCenterX(fl.lane, 1);
      ctx.fillStyle = `rgba(255,60,60,${(0.45 * fade).toFixed(3)})`;
      ctx.fillRect(
        cx - MISS_FLASH_HALF_W,
        hitY - MISS_FLASH_H * 0.5,
        MISS_FLASH_HALF_W * 2,
        MISS_FLASH_H,
      );

      flashes[writeIdx++] = fl;
    }
    flashes.length = writeIdx;

    ctx.restore();
  }

  #drawComboPopups(ctx: CanvasRenderingContext2D, nowMs: number): void {
    const popups = this.#comboPopups;
    if (popups.length === 0) return;

    const totalLifeMs = COMBO_GROW_MS + COMBO_HOLD_MS + COMBO_FADE_MS;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 64px serif';

    let writeIdx = 0;
    for (const pop of popups) {
      const age = nowMs - pop.bornMs;
      if (age < 0 || age >= totalLifeMs) continue;

      // Don't render combo=0 (or negative) popups — keep the entry alive so
      // `splice` arithmetic is uniform but draw nothing this frame.
      if (pop.combo > 0) {
        let scale: number;
        let alpha: number;
        let drift: number;
        if (age < COMBO_GROW_MS) {
          // Quadratic ease-out from 0.8 → 1.0.
          const t = age / COMBO_GROW_MS;
          const eased = 1 - (1 - t) * (1 - t);
          scale = 0.8 + 0.2 * eased;
          alpha = 1;
          drift = 0;
        } else if (age < COMBO_GROW_MS + COMBO_HOLD_MS) {
          scale = 1;
          alpha = 1;
          drift = 0;
        } else {
          const t = (age - COMBO_GROW_MS - COMBO_HOLD_MS) / COMBO_FADE_MS;
          scale = 1;
          alpha = 1 - t;
          drift = COMBO_DRIFT_PX * t;
        }

        const text = `${pop.combo}`;
        const cx = STAGE_W / 2;
        const cy = COMBO_BASE_Y - drift;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.globalAlpha = alpha;
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 3;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }

      popups[writeIdx++] = pop;
    }
    popups.length = writeIdx;

    ctx.restore();
  }

  #drawStarPowerBanners(ctx: CanvasRenderingContext2D, nowMs: number): void {
    const banners = this.#starBanners;
    if (banners.length === 0) return;

    const totalMs = SP_SLIDE_IN_MS + SP_HOLD_MS + SP_SLIDE_OUT_MS;
    const cy = STAGE_H * 0.5;

    let writeIdx = 0;
    for (const b of banners) {
      const age = nowMs - b.bornMs;
      if (age < 0 || age >= totalMs) continue;

      // Compute X (slide-in / hold / slide-out) and pulse scale.
      let cx: number;
      let pulse = 1;
      if (age < SP_SLIDE_IN_MS) {
        // Ease-out from -STAGE_W/2 → STAGE_W/2.
        const t = age / SP_SLIDE_IN_MS;
        const eased = 1 - (1 - t) * (1 - t);
        cx = -STAGE_W * 0.5 + STAGE_W * eased;
      } else if (age < SP_SLIDE_IN_MS + SP_HOLD_MS) {
        cx = STAGE_W * 0.5;
        const tHold = (age - SP_SLIDE_IN_MS) / 1000;
        pulse = 1 + SP_PULSE_AMPLITUDE * Math.sin(2 * Math.PI * SP_PULSE_HZ * tHold);
      } else {
        // Ease-in from STAGE_W/2 → 1.5*STAGE_W (off-screen right).
        const t = (age - SP_SLIDE_IN_MS - SP_HOLD_MS) / SP_SLIDE_OUT_MS;
        const eased = t * t;
        cx = STAGE_W * 0.5 + STAGE_W * eased;
      }

      // Translucent cyan beam underneath.
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const beamGrad = ctx.createLinearGradient(
        0,
        cy - SP_BANNER_H * 0.5,
        0,
        cy + SP_BANNER_H * 0.5,
      );
      beamGrad.addColorStop(0, 'rgba(0,0,0,0)');
      beamGrad.addColorStop(0.5, 'rgba(80,220,255,0.55)');
      beamGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = beamGrad;
      ctx.fillRect(0, cy - SP_BANNER_H * 0.5, STAGE_W, SP_BANNER_H);
      ctx.restore();

      // The banner text itself with a slight diagonal tilt.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-0.08);
      ctx.scale(pulse, pulse);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold italic 96px serif';

      // Cyan→magenta horizontal gradient, sized to the text bounding band.
      const textGrad = ctx.createLinearGradient(-STAGE_W * 0.4, 0, STAGE_W * 0.4, 0);
      textGrad.addColorStop(0, '#5be8ff');
      textGrad.addColorStop(0.5, '#ffffff');
      textGrad.addColorStop(1, '#ff5cf0');
      ctx.fillStyle = textGrad;

      ctx.shadowColor = 'rgba(120,220,255,0.85)';
      ctx.shadowBlur = 24;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.fillText('STAR POWER!', 0, 0);
      ctx.restore();

      banners[writeIdx++] = b;
    }
    banners.length = writeIdx;
  }
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Lane fill colour as a comma-separated `r,g,b` triplet, with a brightness
 * boost for `perfect` (pushed toward white) so perfect bursts visibly pop
 * against great/good ones.
 */
function particleColorRgb(lane: Lane, judgment: Exclude<Judgment, 'miss'>): string {
  const hex = lane === 'L' ? THEME.laneL.fill : THEME.laneR.fill;
  const base = hexToRgb(hex);
  if (judgment === 'perfect') {
    const r = Math.min(255, Math.round(base.r + (255 - base.r) * 0.7));
    const g = Math.min(255, Math.round(base.g + (255 - base.g) * 0.7));
    const b = Math.min(255, Math.round(base.b + (255 - base.b) * 0.7));
    return `${r},${g},${b}`;
  }
  return `${base.r},${base.g},${base.b}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  // Accepts `#rgb` or `#rrggbb`.
  const cleaned = hex.startsWith('#') ? hex.slice(1) : hex;
  if (cleaned.length === 3) {
    const c0 = cleaned.slice(0, 1);
    const c1 = cleaned.slice(1, 2);
    const c2 = cleaned.slice(2, 3);
    const r = parseInt(c0 + c0, 16);
    const g = parseInt(c1 + c1, 16);
    const b = parseInt(c2 + c2, 16);
    return {
      r: Number.isFinite(r) ? r : 255,
      g: Number.isFinite(g) ? g : 255,
      b: Number.isFinite(b) ? b : 255,
    };
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    return {
      r: Number.isFinite(r) ? r : 255,
      g: Number.isFinite(g) ? g : 255,
      b: Number.isFinite(b) ? b : 255,
    };
  }
  return { r: 255, g: 255, b: 255 };
}
