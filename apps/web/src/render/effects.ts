/**
 * Visual effects layer for the Bongos Hero highway.
 *
 * Owns seven families of feedback:
 *   1. Hit bursts        — radial particle pop + expanding white "tap ring"
 *      when a note is judged perfect/great/good.
 *   2. Miss flashes      — translucent red rectangle over the failed lane,
 *      coupled with a screen-shake impulse.
 *   3. Comic miss bursts — jagged starburst with an outlined onomatopoeic
 *      word ("BONK!", "POW!", …) shifted outward of the failed lane, so the
 *      note approach path is not occluded. Spawned alongside the miss flash.
 *   4. Combo popups      — large "100", "200", … floating text spawned by the
 *      play scene at score thresholds.
 *   5. Star Power banner — diagonal "STAR POWER!" sweep across the stage when
 *      SP is activated, plus a translucent screen-blended cyan beam.
 *   6. Combo milestones  — distinct centred flourishes (radial wave +
 *      optional edge-glow pulse + optional gold "COMBO N!" text) when the
 *      player crosses 25 / 50 / 100+ combo thresholds. Pool of 4 fixed
 *      slots — rare effect, no per-frame allocation.
 *   7. Confetti          — gravity-driven rectangular particles fired from
 *      the results scene on a 5★ (cannons) or 4★ (centre burst) outcome.
 *      Pool of {@link MAX_CONFETTI} preallocated slots — never allocates
 *      per frame, including no per-particle `fillStyle` string assembly
 *      (palette colours are pre-stringified at module init).
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
import { getActivePalette, THEME } from './theme.js';

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

/** Comic-style miss burst keyframes (total 500 ms). */
const COMIC_POPIN_MS = 100;
const COMIC_SETTLE_MS = 80;
const COMIC_HOLD_MS = 200;
const COMIC_FADE_MS = 120;
const COMIC_TOTAL_MS = COMIC_POPIN_MS + COMIC_SETTLE_MS + COMIC_HOLD_MS + COMIC_FADE_MS;

/** Comic burst geometry. */
const COMIC_OUTER_R = 80;
const COMIC_INNER_R = 48;
const COMIC_SPIKES = 12;
const COMIC_FONT_PX = 46;
const COMIC_TEXT_STROKE_PX = 6;
const COMIC_OUTLINE_STROKE_PX = 5;

/**
 * Vertical anchor of the burst centre. Sits above the hit line (`y=600`) and
 * below the highway midpoint, comfortably out of the typical note approach
 * window once combined with the outward lateral bias below.
 */
const COMIC_BASE_Y = 460;
/**
 * Horizontal push **away from highway centre**, so the burst sits outside the
 * lane edge and does not occlude the note path. L misses shift further left,
 * R misses further right.
 */
const COMIC_LANE_OUTWARD_PX = 100;
const COMIC_X_JITTER_PX = 18;
const COMIC_Y_JITTER_PX = 14;
const COMIC_TILT_RANGE_RAD = 0.35;

/** Cap simultaneous live bursts. Drop the oldest on overflow. */
const COMIC_MAX_LIVE = 4;

/** Hold-phase wobble. */
const COMIC_WOBBLE_HZ = 8;
const COMIC_WOBBLE_AMPLITUDE = 0.025;

/** Fade-phase upward drift. */
const COMIC_DRIFT_PX = 22;

const COMIC_WORDS: readonly string[] = [
  'BONK!',
  'OOF!',
  'WHIFF!',
  'POW!',
  'CLUNK!',
  'OUCH!',
  'DOH!',
  'WHAM!',
  'OOPS!',
  'MISS!',
];

interface ComicPalette {
  /** Outer starburst fill. */
  fill: string;
  /** Inner highlight fill (lighter). */
  inner: string;
}

const COMIC_PALETTES: readonly ComicPalette[] = [
  { fill: '#ffd23f', inner: '#fff48a' },
  { fill: '#ff5a3c', inner: '#ff9b7a' },
];

const COMIC_FALLBACK_WORD = 'BONK!';
const COMIC_FALLBACK_PALETTE: ComicPalette = { fill: '#ffd23f', inner: '#fff48a' };

/**
 * Combo-milestone keyframes. Three flavors share the radial wave; `super`
 * adds a screen-edge alpha pulse, `legend` adds the edge pulse plus the
 * gold "COMBO N!" centre text. Pool is fixed-size so the per-frame draw
 * never allocates.
 */
const MILESTONE_POOL_SIZE = 4;
/** Wave duration (basic). Also the lower bound for the other flavors. */
const MILESTONE_WAVE_MS = 800;
/** Edge-glow pulse duration (super + legend). */
const MILESTONE_EDGE_MS = 1000;
/** Centre-text duration (legend only). Pop-in / hold / fade spans this total. */
const MILESTONE_TEXT_MS = 1100;
/** Wave geometry: ring expands from R0 to R1 over MILESTONE_WAVE_MS. */
const MILESTONE_WAVE_R0 = 60;
const MILESTONE_WAVE_R1 = 460;
const MILESTONE_WAVE_LINE_PX = 6;
const MILESTONE_WAVE_ALPHA0 = 0.7;
/** Width (px) of each side-edge alpha bar drawn by `super` / `legend`. */
const MILESTONE_EDGE_WIDTH_PX = 110;
/** Peak alpha at the midpoint of the edge pulse (envelope is 0→peak→0). */
const MILESTONE_EDGE_PEAK_ALPHA = 0.4;
/** Legend-flavor centre-text font size. */
const MILESTONE_TEXT_PX = 96;
const MILESTONE_TEXT_Y = STAGE_H * 0.5;
/** Text pop-in / hold / fade keyframes (sum = MILESTONE_TEXT_MS). */
const MILESTONE_TEXT_POPIN_MS = 160;
const MILESTONE_TEXT_HOLD_MS = 600;
const MILESTONE_TEXT_FADE_MS = 340;

// ---- Confetti tunables ------------------------------------------------------

/**
 * Hard ceiling for live confetti rectangles. Sized for the worst case the
 * results scene throws at the renderer (a 5★ outcome fires ~50 from two
 * cannons; 80 leaves headroom for back-to-back results without recycling
 * mid-fall).
 */
const MAX_CONFETTI = 80;

/** Confetti particle lifetime, in ms. */
const CONFETTI_LIFETIME_MS = 2400;

/** Gravity (px/s²). Strong enough to make the cannons rain down inside ~2 s. */
const CONFETTI_GRAVITY_PX_S2 = 700;

/** Initial speed range, px/s. */
const CONFETTI_SPEED_MIN = 380;
const CONFETTI_SPEED_MAX = 720;

/** Rectangle size range, px (stage-space). */
const CONFETTI_SIZE_MIN = 6;
const CONFETTI_SIZE_MAX = 12;

/** Rotation velocity range (rad/s). Half spin to two full spins per second. */
const CONFETTI_ROT_VEL_MIN = -Math.PI * 4;
const CONFETTI_ROT_VEL_MAX = Math.PI * 4;

/**
 * Confetti palette — pre-stringified `#rrggbb` colors. Mixed warm + cool so
 * the burst reads as celebratory regardless of which lane palette is active.
 * Picked once per particle at spawn time; no per-frame string allocation.
 */
const CONFETTI_COLORS: readonly string[] = [
  '#ffd23f', // gold
  '#ff5cf0', // magenta
  '#5be8ff', // cyan
  '#5ad7ff', // sky
  '#fff48a', // pale gold
  '#c479ff', // violet
  '#ff8a5c', // coral
  '#7cffb1', // mint
];

/** Spawn fan half-angle (rad) — how wide each cannon sprays around its aim. */
const CONFETTI_FAN_HALF_RAD = Math.PI / 4;

/** Particle counts for the two scene-level helpers. */
const CONFETTI_5_STAR_COUNT = 50;
const CONFETTI_4_STAR_COUNT = 20;

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

interface ComicBurst {
  bornMs: number;
  /** World-space centre X (already includes lateral outward bias + jitter). */
  cx: number;
  /** World-space centre Y. */
  cy: number;
  word: string;
  palette: ComicPalette;
  tiltRad: number;
}

/**
 * Combo-milestone flourish. One pool entry per slot — `active=false` means
 * the slot is free. Three flavors stack visuals: `basic` is wave only,
 * `super` adds an edge pulse, `legend` adds wave + edge + gold centre text.
 */
export type MilestoneFlavor = 'basic' | 'super' | 'legend';

export interface Milestone {
  active: boolean;
  startMs: number;
  /** Threshold value that triggered the spawn (25 / 50 / 100 / 150 / …). */
  combo: number;
  flavor: MilestoneFlavor;
}

/**
 * Confetti particle pool slot. `active=false` means the slot is free.
 *
 * Position / velocity are stage-space (1280×720); `rotation` is radians and
 * advances by `rotationVel` per second. `color` is a pre-stringified
 * `#rrggbb` literal from {@link CONFETTI_COLORS} — picked at spawn so the
 * draw loop never has to assemble an `rgba(...)` string per particle.
 */
export interface ConfettiParticle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationVel: number;
  color: string;
  size: number;
  spawnedAtMs: number;
  lifetimeMs: number;
}

/**
 * Total visible lifetime of a milestone, derived from its flavor — the
 * draw pass uses this to retire the slot back to `active=false`.
 */
function milestoneLifeMs(flavor: MilestoneFlavor): number {
  if (flavor === 'basic') return MILESTONE_WAVE_MS;
  if (flavor === 'super') return Math.max(MILESTONE_WAVE_MS, MILESTONE_EDGE_MS);
  // legend: longest of the three pieces.
  return Math.max(MILESTONE_WAVE_MS, MILESTONE_EDGE_MS, MILESTONE_TEXT_MS);
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
  readonly #comicBursts: ComicBurst[] = [];

  /**
   * Combo-milestone pool. Fixed length — the slot's `active` flag gates
   * draw + reuse so the array length is never mutated post-construction.
   * Keeps the per-frame draw allocation-free.
   */
  readonly #milestones: Milestone[];

  /**
   * Confetti pool. Fixed length — `active=false` slots are free for the next
   * burst. Spawn helpers walk the pool in order so saturated bursts simply
   * truncate instead of evicting still-falling pieces.
   */
  readonly #confetti: ConfettiParticle[];

  /** Index of the last comic word picked, so we can avoid an immediate repeat. */
  #lastComicWordIdx = -1;
  /** Counter used to alternate the comic palette per spawn. */
  #comicPaletteIdx = 0;

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
    this.#milestones = new Array<Milestone>(MILESTONE_POOL_SIZE);
    for (let i = 0; i < MILESTONE_POOL_SIZE; i++) {
      this.#milestones[i] = {
        active: false,
        startMs: 0,
        combo: 0,
        flavor: 'basic',
      };
    }
    this.#confetti = new Array<ConfettiParticle>(MAX_CONFETTI);
    for (let i = 0; i < MAX_CONFETTI; i++) {
      this.#confetti[i] = {
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        rotation: 0,
        rotationVel: 0,
        color: CONFETTI_COLORS[0] ?? '#ffffff',
        size: 0,
        spawnedAtMs: 0,
        lifetimeMs: 0,
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
    this.#spawnComicBurst(lane, nowMs);
  }

  spawnComboPopup(combo: number, nowMs: number): void {
    this.#comboPopups.push({ combo, bornMs: nowMs });
  }

  /**
   * Claim a free pool slot for a combo-milestone flourish. Silently no-ops
   * if every slot is already in use — milestones are rare (combo crossings
   * are sparse), so saturation is not expected; dropping the spawn is
   * preferable to evicting a still-animating earlier milestone.
   */
  spawnMilestone(combo: number, flavor: MilestoneFlavor, nowMs: number): void {
    const pool = this.#milestones;
    for (const slot of pool) {
      if (slot.active) continue;
      slot.active = true;
      slot.startMs = nowMs;
      slot.combo = combo;
      slot.flavor = flavor;
      return;
    }
  }

  spawnStarPowerActivated(nowMs: number): void {
    this.#starBanners.push({ bornMs: nowMs });
  }

  /**
   * Spawn up to `count` confetti particles from a single origin. Each piece
   * gets a random fan-spread velocity, a random palette colour, and a random
   * rotational kick. Particles drop under gravity, fade out as they near
   * their lifetime, and recycle in place — the pool is fixed-length so this
   * method never grows any array.
   *
   * Returns the number of slots actually claimed (clipped against the free
   * pool capacity). Useful for tests; callers usually ignore it.
   *
   * `aimAngle` is the central direction of the spray, in radians. The
   * convention is the canvas one (0 = +x right, π/2 = +y down), so passing
   * `-Math.PI / 2` aims straight up; the helpers below use angles that fan
   * inward from each cannon.
   */
  spawnConfetti(
    originX: number,
    originY: number,
    count: number,
    nowMs: number,
    aimAngle = -Math.PI / 2,
  ): number {
    const pool = this.#confetti;
    let claimed = 0;
    for (let i = 0; i < pool.length && claimed < count; i++) {
      const slot = pool[i];
      if (slot === undefined || slot.active) continue;

      const spread = (Math.random() - 0.5) * 2 * CONFETTI_FAN_HALF_RAD;
      const angle = aimAngle + spread;
      const speed = CONFETTI_SPEED_MIN + Math.random() * (CONFETTI_SPEED_MAX - CONFETTI_SPEED_MIN);
      const colorIdx = Math.floor(Math.random() * CONFETTI_COLORS.length);
      const color = CONFETTI_COLORS[colorIdx] ?? CONFETTI_COLORS[0] ?? '#ffffff';

      slot.active = true;
      slot.x = originX;
      slot.y = originY;
      slot.vx = Math.cos(angle) * speed;
      slot.vy = Math.sin(angle) * speed;
      slot.rotation = Math.random() * Math.PI * 2;
      slot.rotationVel =
        CONFETTI_ROT_VEL_MIN + Math.random() * (CONFETTI_ROT_VEL_MAX - CONFETTI_ROT_VEL_MIN);
      slot.color = color;
      slot.size = CONFETTI_SIZE_MIN + Math.random() * (CONFETTI_SIZE_MAX - CONFETTI_SIZE_MIN);
      slot.spawnedAtMs = nowMs;
      slot.lifetimeMs = CONFETTI_LIFETIME_MS;

      claimed++;
    }
    return claimed;
  }

  /**
   * 5★ celebration: two confetti cannons, one anchored just inside each
   * lower screen corner, fired diagonally inward + upward. Splits
   * {@link CONFETTI_5_STAR_COUNT} particles roughly evenly between the two
   * origins.
   */
  spawnConfettiFor5Star(stage: { width: number; height: number }, nowMs: number): void {
    const half = Math.ceil(CONFETTI_5_STAR_COUNT / 2);
    const yOrigin = stage.height * 0.85;
    // Aim each cannon up and toward the centre. Canvas y grows downward so
    // an upward shot is `-π/2`; we then rotate ±0.35 rad toward the middle.
    const leftAim = -Math.PI / 2 + 0.35;
    const rightAim = -Math.PI / 2 - 0.35;
    this.spawnConfetti(stage.width * 0.1, yOrigin, half, nowMs, leftAim);
    this.spawnConfetti(stage.width * 0.9, yOrigin, CONFETTI_5_STAR_COUNT - half, nowMs, rightAim);
  }

  /**
   * 4★ celebration: a small {@link CONFETTI_4_STAR_COUNT}-particle pop from
   * the centre, aimed straight up. Reads as a "nice job" tap rather than a
   * full cannons-and-banners moment.
   */
  spawnSmallBurstFor4Star(stage: { width: number; height: number }, nowMs: number): void {
    this.spawnConfetti(
      stage.width * 0.5,
      stage.height * 0.55,
      CONFETTI_4_STAR_COUNT,
      nowMs,
      -Math.PI / 2,
    );
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
    this.#drawComicBursts(ctx, nowMs);
    this.#drawComboPopups(ctx, nowMs);
    this.#drawStarPowerBanners(ctx, nowMs);
    this.#drawMilestones(ctx, nowMs);
    this.#updateAndDrawConfetti(ctx, dtSec, nowMs);
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
    this.#comicBursts.length = 0;
    for (const m of this.#milestones) {
      m.active = false;
    }
    for (const c of this.#confetti) {
      c.active = false;
    }
    this.#lastComicWordIdx = -1;
    this.#comicPaletteIdx = 0;
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

  // ---- Comic miss burst --------------------------------------------------

  /**
   * Spawn a comic-style explosion burst over the failed lane. Push a fresh
   * burst to the live array, picking a word that is not the immediate
   * previous one and a palette that alternates per call.
   *
   * Position is biased **outward** of the lane edge (left for `L`, right for
   * `R`) so the burst sits beside the note approach path rather than over
   * it. Random X/Y jitter and tilt keep consecutive bursts from stacking
   * identically.
   */
  #spawnComicBurst(lane: Lane, nowMs: number): void {
    // Cap simultaneous live bursts so a long miss streak does not paint
    // over the play area. Drop the oldest (front of the array).
    while (this.#comicBursts.length >= COMIC_MAX_LIVE) {
      this.#comicBursts.shift();
    }

    const word = pickComicWord(this.#lastComicWordIdx);
    this.#lastComicWordIdx = word.idx;

    const palette =
      COMIC_PALETTES[this.#comicPaletteIdx % COMIC_PALETTES.length] ?? COMIC_FALLBACK_PALETTE;
    this.#comicPaletteIdx++;

    const outward = lane === 'L' ? -COMIC_LANE_OUTWARD_PX : COMIC_LANE_OUTWARD_PX;
    const cx = laneCenterX(lane, 1) + outward + (Math.random() - 0.5) * 2 * COMIC_X_JITTER_PX;
    const cy = COMIC_BASE_Y + (Math.random() - 0.5) * 2 * COMIC_Y_JITTER_PX;
    const tiltRad = (Math.random() - 0.5) * 2 * COMIC_TILT_RANGE_RAD;

    this.#comicBursts.push({
      bornMs: nowMs,
      cx,
      cy,
      word: word.text,
      palette,
      tiltRad,
    });
  }

  /**
   * Draw every live comic burst. Three layers per burst, all drawn inside
   * one `save` / `restore` so transforms and styles never leak:
   *   1. Outer jagged starburst (palette fill + black outline).
   *   2. Inner highlight starburst (lighter fill, no outline).
   *   3. The onomatopoeic word (white fill + chunky black stroke).
   *
   * `globalAlpha` is multiplied (not assigned) so a parent alpha — for
   * example a router crossfade — composes correctly.
   */
  #drawComicBursts(ctx: CanvasRenderingContext2D, nowMs: number): void {
    const bursts = this.#comicBursts;
    if (bursts.length === 0) return;

    let writeIdx = 0;
    for (const burst of bursts) {
      const age = nowMs - burst.bornMs;
      if (age < 0 || age >= COMIC_TOTAL_MS) continue;

      let scale: number;
      let alpha: number;
      let drift: number;
      if (age < COMIC_POPIN_MS) {
        // Pop-in: cubic ease-out scale 0 → 1.18, alpha ramp 0 → 1.
        const t = age / COMIC_POPIN_MS;
        const inv = 1 - t;
        const eased = 1 - inv * inv * inv;
        scale = 1.18 * eased;
        alpha = t;
        drift = 0;
      } else if (age < COMIC_POPIN_MS + COMIC_SETTLE_MS) {
        // Settle: scale 1.18 → 1.0, full alpha.
        const t = (age - COMIC_POPIN_MS) / COMIC_SETTLE_MS;
        scale = 1.18 - 0.18 * t;
        alpha = 1;
        drift = 0;
      } else if (age < COMIC_POPIN_MS + COMIC_SETTLE_MS + COMIC_HOLD_MS) {
        // Hold: tiny wobble, full alpha.
        const tHold = (age - COMIC_POPIN_MS - COMIC_SETTLE_MS) / 1000;
        scale = 1 + COMIC_WOBBLE_AMPLITUDE * Math.sin(2 * Math.PI * COMIC_WOBBLE_HZ * tHold);
        alpha = 1;
        drift = 0;
      } else {
        // Fade: alpha 1 → 0, gentle upward drift, slight scale-up.
        const t = (age - COMIC_POPIN_MS - COMIC_SETTLE_MS - COMIC_HOLD_MS) / COMIC_FADE_MS;
        scale = 1 + 0.04 * t;
        alpha = 1 - t;
        drift = COMIC_DRIFT_PX * t;
      }

      ctx.save();
      const parentAlpha = ctx.globalAlpha;
      ctx.globalAlpha = parentAlpha * alpha;
      ctx.translate(burst.cx, burst.cy - drift);
      ctx.rotate(burst.tiltRad);
      ctx.scale(scale, scale);

      // 1. Outer starburst (filled + outlined).
      ctx.lineJoin = 'miter';
      ctx.miterLimit = 6;
      ctx.lineWidth = COMIC_OUTLINE_STROKE_PX;
      ctx.strokeStyle = '#000000';
      ctx.fillStyle = burst.palette.fill;
      drawStarburstPath(ctx, COMIC_OUTER_R, COMIC_INNER_R, COMIC_SPIKES);
      ctx.fill();
      ctx.stroke();

      // 2. Inner highlight starburst (no outline, lighter colour).
      ctx.fillStyle = burst.palette.inner;
      drawStarburstPath(ctx, COMIC_OUTER_R * 0.62, COMIC_INNER_R * 0.62, COMIC_SPIKES);
      ctx.fill();

      // 3. Onomatopoeic word.
      ctx.font = `900 italic ${COMIC_FONT_PX}px "Arial Black", Impact, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = COMIC_TEXT_STROKE_PX;
      ctx.strokeStyle = '#000000';
      ctx.fillStyle = '#ffffff';
      ctx.strokeText(burst.word, 0, 0);
      ctx.fillText(burst.word, 0, 0);

      ctx.restore();

      bursts[writeIdx++] = burst;
    }
    bursts.length = writeIdx;
  }

  // ---- Combo milestones ---------------------------------------------------

  /**
   * Draw every active combo-milestone slot. Three flavors stack visuals
   * over the shared radial wave:
   *   - basic  → wave only (concentric expanding ring, fades over 800 ms).
   *   - super  → wave + edge-glow alpha pulse (left + right side bars).
   *   - legend → wave + edge-glow + gold "COMBO N!" centre text.
   *
   * The active palette (read once per slot, not per-pixel) provides the
   * stroke / fill colour so colourblind players see palette-aware colours.
   * The fixed-size pool means the iteration never allocates: completed
   * slots flip `active=false` in place and become reusable on next spawn.
   */
  #drawMilestones(ctx: CanvasRenderingContext2D, nowMs: number): void {
    const pool = this.#milestones;
    if (pool.length === 0) return;

    // Read the active palette once per draw pass; both lanes' glows and
    // the gold ring colour come from the same `LanePalette` instance.
    const palette = getActivePalette();

    for (const m of pool) {
      if (!m.active) continue;
      const age = nowMs - m.startMs;
      const lifeMs = milestoneLifeMs(m.flavor);
      if (age < 0 || age >= lifeMs) {
        m.active = false;
        continue;
      }

      // 1. Shared radial wave (all flavors).
      if (age < MILESTONE_WAVE_MS) {
        const t = age / MILESTONE_WAVE_MS;
        const r = MILESTONE_WAVE_R0 + (MILESTONE_WAVE_R1 - MILESTONE_WAVE_R0) * t;
        const alpha = MILESTONE_WAVE_ALPHA0 * (1 - t);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineWidth = MILESTONE_WAVE_LINE_PX;
        ctx.strokeStyle = palette.L.ringHit;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(STAGE_W / 2, STAGE_H / 2, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 2. Edge-glow alpha pulse (super + legend) — 0 → peak → 0 envelope.
      if ((m.flavor === 'super' || m.flavor === 'legend') && age < MILESTONE_EDGE_MS) {
        const t = age / MILESTONE_EDGE_MS;
        const env = Math.sin(Math.PI * t); // 0 → 1 → 0
        const alpha = MILESTONE_EDGE_PEAK_ALPHA * env;
        if (alpha > 0) {
          ctx.save();
          ctx.fillStyle = palette.R.glow;
          ctx.globalAlpha = alpha;
          ctx.fillRect(0, 0, MILESTONE_EDGE_WIDTH_PX, STAGE_H);
          ctx.fillRect(STAGE_W - MILESTONE_EDGE_WIDTH_PX, 0, MILESTONE_EDGE_WIDTH_PX, STAGE_H);
          ctx.restore();
        }
      }

      // 3. Gold "COMBO N!" centre text (legend only).
      if (m.flavor === 'legend' && age < MILESTONE_TEXT_MS) {
        let scale: number;
        let alpha: number;
        if (age < MILESTONE_TEXT_POPIN_MS) {
          const t = age / MILESTONE_TEXT_POPIN_MS;
          const eased = 1 - (1 - t) * (1 - t);
          scale = 0.7 + 0.3 * eased;
          alpha = t;
        } else if (age < MILESTONE_TEXT_POPIN_MS + MILESTONE_TEXT_HOLD_MS) {
          scale = 1;
          alpha = 1;
        } else {
          const t =
            (age - MILESTONE_TEXT_POPIN_MS - MILESTONE_TEXT_HOLD_MS) / MILESTONE_TEXT_FADE_MS;
          scale = 1 + 0.06 * t;
          alpha = 1 - t;
        }
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(STAGE_W / 2, MILESTONE_TEXT_Y);
        ctx.scale(scale, scale);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `900 italic ${MILESTONE_TEXT_PX}px "Arial Black", Impact, sans-serif`;
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 18;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 4;
        // ringHit is the palette's gold accent — same `#ffd56a` in both the
        // default and colourblind palettes today, but pulling from the
        // palette keeps any future re-skin honest.
        ctx.fillStyle = palette.L.ringHit;
        ctx.fillText(`COMBO ${m.combo}!`, 0, 0);
        ctx.restore();
      }
    }
  }

  // ---- Confetti -----------------------------------------------------------

  /**
   * Update + draw the confetti pool. Each particle:
   *   - integrates `vy += g * dt` then `x/y += v * dt`
   *   - advances `rotation` by `rotationVel * dt`
   *   - fades alpha linearly as `t/lifetime` approaches 1
   *
   * Draw is a single `save / translate / rotate / fillRect / restore` per
   * live slot — no string assembly per particle (the colour was pre-stringified
   * at spawn, and `fillStyle` is set once per slot, not from a template). The
   * pool is fixed-length so this whole pass allocates nothing.
   */
  #updateAndDrawConfetti(ctx: CanvasRenderingContext2D, dtSec: number, nowMs: number): void {
    const pool = this.#confetti;
    if (pool.length === 0) return;

    const gravityDelta = CONFETTI_GRAVITY_PX_S2 * dtSec;
    const parentAlpha = ctx.globalAlpha;

    for (const p of pool) {
      if (!p.active) continue;

      const age = nowMs - p.spawnedAtMs;
      if (age < 0 || age >= p.lifetimeMs || p.lifetimeMs <= 0) {
        p.active = false;
        continue;
      }

      // Physics integration. Skip the position update entirely on the very
      // first frame after spawn (dtSec=0) so the particle still draws at its
      // origin instead of getting one free-fall step from a stale dt.
      if (dtSec > 0) {
        p.vy += gravityDelta;
        p.x += p.vx * dtSec;
        p.y += p.vy * dtSec;
        p.rotation += p.rotationVel * dtSec;
      }

      const lifeT = age / p.lifetimeMs;
      // Hold full alpha for the first ~70% of the life, then linear-fade
      // so the burst stays visible while it falls then quietly disappears.
      const alpha = lifeT < 0.7 ? 1 : Math.max(0, 1 - (lifeT - 0.7) / 0.3);
      if (alpha <= 0) continue;

      ctx.save();
      ctx.globalAlpha = parentAlpha * alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      // Centre the rectangle on the origin so rotation pivots the centre.
      const half = p.size * 0.5;
      ctx.fillRect(-half, -half * 0.5, p.size, p.size * 0.5);
      ctx.restore();
    }
  }
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Pick a comic word at random, biased to never match `lastIdx` (so the same
 * word does not appear back-to-back during a miss streak). Returns both the
 * text and the chosen index so the caller can update its rolling state.
 */
function pickComicWord(lastIdx: number): { text: string; idx: number } {
  const n = COMIC_WORDS.length;
  if (n === 0) return { text: COMIC_FALLBACK_WORD, idx: -1 };
  if (n === 1) return { text: COMIC_WORDS[0] ?? COMIC_FALLBACK_WORD, idx: 0 };

  // Pick uniformly from the n-1 indices that are not lastIdx, by drawing
  // from [0, n-1) and skipping past lastIdx if hit. No allocation.
  const draw = Math.floor(Math.random() * (n - 1));
  const idx = draw < lastIdx || lastIdx < 0 ? draw : draw + 1;
  return { text: COMIC_WORDS[idx] ?? COMIC_FALLBACK_WORD, idx };
}

/**
 * Trace a closed jagged starburst path centred at the current transform
 * origin. `spikes` outer points alternate with `spikes` inner valleys for
 * `2 * spikes` total vertices. Pure path construction — does not fill or
 * stroke. Caller controls style and `fill()` / `stroke()` order.
 */
function drawStarburstPath(
  ctx: CanvasRenderingContext2D,
  outerR: number,
  innerR: number,
  spikes: number,
): void {
  const total = spikes * 2;
  ctx.beginPath();
  for (let i = 0; i < total; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (i * Math.PI) / spikes - Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

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
