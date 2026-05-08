/**
 * Pre-rendered drumhead sprites for the bongo notes.
 *
 * Rasterising radial gradients per note per frame is by far the dominant cost
 * in a Canvas 2D rhythm game with many simultaneous notes on screen. We
 * sidestep that entirely by drawing each lane's drumhead once at its largest
 * (hit-line) scale into an `OffscreenCanvas` (or detached `<canvas>` fallback)
 * and then `drawImage`-blitting that texture every frame. Per-frame work
 * collapses to a single GPU-accelerated bitmap blit per note, which scales to
 * hundreds of notes comfortably.
 *
 * Sprites are lazily built on first request and cached for the lifetime of
 * the module.
 */

import type { Lane } from '@bongos-hero/shared';

import { subscribePalette, THEME } from './theme.js';

export interface NoteSprite {
  /** Source canvas to drawImage. */
  source: HTMLCanvasElement | OffscreenCanvas;
  /** Width of the source in px (== height; sprites are square). */
  size: number;
  /** Anchor offset within the sprite (== size/2). */
  anchor: number;
}

// ---- Sprite geometry --------------------------------------------------------

/** Square footprint of every sprite, in pixels. */
const SPRITE_SIZE = 96;
const SPRITE_ANCHOR = SPRITE_SIZE / 2;

/** Drum-head radius (the opaque circle), measured from the sprite centre. */
const HEAD_RADIUS = 36;
/** Width of the dark outer rim stroke. */
const HEAD_RIM_WIDTH = 2;
/** Radius of the inner highlight ring (~80% of the head radius). */
const HEAD_INNER_RING_RADIUS = HEAD_RADIUS * 0.8;

// ---- Sustain trail sprite geometry -----------------------------------------
//
// The trail is drawn under (visually behind) a sustain note's drum head and
// extends from the head's centre back to its `expectedEndMs` position on the
// highway. We pre-rasterise it as a tall, narrow pill with a soft horizontal
// gradient so the renderer can blit + scale a single bitmap per frame. Width
// is constant (no perspective taper) — the renderer scales the whole sprite
// uniformly to match the head's shrink with distance from the hit line.

/** Width of the trail sprite in px (matches the head's vertical mid-band). */
const TRAIL_WIDTH = 32;
/** Height of the trail sprite source bitmap. The renderer stretches this to
 *  the actual screen length, so the source just needs enough vertical extent
 *  that the rounded caps remain crisp after stretching. */
const TRAIL_HEIGHT = 128;
/** Rounded-cap radius at the top and bottom of the trail. */
const TRAIL_CAP_RADIUS = TRAIL_WIDTH / 2;

// ---- Lib type compatibility ------------------------------------------------
//
// `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D` are
// nominally distinct in the DOM lib but expose the same drawing surface for
// the operations we need here. The union type keeps the sprite builder
// agnostic to which backing canvas we ended up with.

type AnyCtx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// ---- Caches ----------------------------------------------------------------

const laneSpriteCache = new Map<Lane, NoteSprite>();
let spOverlayCache: NoteSprite | null = null;
const trailSpriteCache = new Map<Lane, NoteSprite>();

// ---- Helpers ----------------------------------------------------------------

/**
 * Multiplicatively scale every channel of a `#rrggbb` colour toward black.
 * `factor < 1` darkens, `factor > 1` lightens (clamped at 255).
 */
function darkenHex(hex: string, factor: number): string {
  const r = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(1, 3), 16) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(3, 5), 16) * factor)));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(5, 7), 16) * factor)));
  return `rgb(${r},${g},${b})`;
}

/**
 * Linearly blend a `#rrggbb` colour toward white by `factor` in `[0, 1]`.
 * Used for the inner highlight ring on top of the drum head.
 */
function lightenHex(hex: string, factor: number): string {
  const r0 = parseInt(hex.slice(1, 3), 16);
  const g0 = parseInt(hex.slice(3, 5), 16);
  const b0 = parseInt(hex.slice(5, 7), 16);
  const r = Math.round(r0 + (255 - r0) * factor);
  const g = Math.round(g0 + (255 - g0) * factor);
  const b = Math.round(b0 + (255 - b0) * factor);
  return `rgb(${r},${g},${b})`;
}

/**
 * Allocate an offscreen drawing surface and run the supplied painter against
 * its 2D context. Prefers `OffscreenCanvas` when the runtime supports it
 * (faster on most browsers and worker-friendly), otherwise falls back to a
 * detached `<canvas>` element.
 *
 * Sprites are square unless `height` is supplied — pass it for trail-style
 * pill sprites that need a different aspect ratio. The reported `anchor`
 * stays at `width/2` (sprites pin to their horizontal centre when blitted).
 */
function buildSprite(
  paint: (ctx: AnyCtx2D) => void,
  width: number,
  height: number = width,
): NoteSprite {
  if ('OffscreenCanvas' in globalThis) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('noteSprites: OffscreenCanvas 2D context unavailable');
    }
    paint(ctx);
    return { source: canvas, size: width, anchor: width / 2 };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('noteSprites: HTMLCanvasElement 2D context unavailable');
  }
  paint(ctx);
  return { source: canvas, size: width, anchor: width / 2 };
}

// ---- Sprite painters --------------------------------------------------------

/**
 * Paint a single bongo drumhead sprite for the given lane. Rendered once at
 * its largest (hit-line) size; the renderer scales it down via `drawImage`
 * for notes further up the highway.
 */
function paintLaneSprite(ctx: AnyCtx2D, lane: Lane): void {
  const fill = lane === 'L' ? THEME.laneL.fill : THEME.laneR.fill;
  const glow = lane === 'L' ? THEME.laneL.glow : THEME.laneR.glow;

  const cx = SPRITE_ANCHOR;
  const cy = SPRITE_ANCHOR;

  // 1. Outer halo. The glow sits behind the drum head and bleeds out to the
  //    canvas edge so that scaled-up sprites still bloom past the rim.
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, SPRITE_ANCHOR);
  halo.addColorStop(0.5, glow);
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

  // 2. Drumhead fill: bright at the centre, ~30% darker at the rim.
  const head = ctx.createRadialGradient(cx, cy, 0, cx, cy, HEAD_RADIUS);
  head.addColorStop(0, fill);
  head.addColorStop(1, darkenHex(fill, 0.7));
  ctx.beginPath();
  ctx.arc(cx, cy, HEAD_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = head;
  ctx.fill();

  // 3. Outer dark rim (2 px stroke, sat just inside the head radius so it
  //    reads as a band rather than antialiasing into the halo).
  ctx.strokeStyle = darkenHex(fill, 0.35);
  ctx.lineWidth = HEAD_RIM_WIDTH;
  ctx.beginPath();
  ctx.arc(cx, cy, HEAD_RADIUS - HEAD_RIM_WIDTH * 0.5, 0, Math.PI * 2);
  ctx.stroke();

  // 4. Inner 1 px highlight ring at ~80% radius (suggests stretched skin).
  ctx.strokeStyle = lightenHex(fill, 0.45);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, HEAD_INNER_RING_RADIUS, 0, Math.PI * 2);
  ctx.stroke();

  // 5. Glossy ellipse highlight in the upper-left quadrant.
  ctx.beginPath();
  ctx.ellipse(
    cx - HEAD_RADIUS * 0.3,
    cy - HEAD_RADIUS * 0.42,
    HEAD_RADIUS * 0.45,
    HEAD_RADIUS * 0.2,
    -Math.PI / 5,
    0,
    Math.PI * 2,
  );
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fill();
}

/**
 * Paint the Star-Power overlay sprite — a five-point star inside a soft cyan
 * halo. The renderer composites this on top of the drum head with `screen`
 * blend so it brightens rather than tints.
 */
function paintSpOverlay(ctx: AnyCtx2D): void {
  const cx = SPRITE_ANCHOR;
  const cy = SPRITE_ANCHOR;

  // Soft cyan halo behind the star.
  const halo = ctx.createRadialGradient(cx, cy, HEAD_RADIUS * 0.2, cx, cy, SPRITE_ANCHOR);
  halo.addColorStop(0, 'rgba(180,240,255,0.55)');
  halo.addColorStop(0.55, 'rgba(120,200,255,0.20)');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

  // 5-point star, outer radius slightly larger than the drumhead so the
  // points poke out past the rim.
  const outerR = HEAD_RADIUS * 1.05;
  const innerR = outerR * 0.42;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(ang) * r;
    const y = cy + Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(220,245,255,0.55)';
  ctx.fill();

  // Bright inner star core, gives the centre a hot pop.
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = (i % 2 === 0 ? outerR : innerR) * 0.55;
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(ang) * r;
    const y = cy + Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fill();
}

/**
 * Paint the sustain-trail sprite for the given lane. A vertical pill with
 * rounded caps and a soft horizontal gradient (lane glow on the outer
 * edges, lane fill in the centre) so the trail reads as a glowing rope of
 * the lane colour. Drawn under the drum head; the renderer can additionally
 * overpaint with `globalCompositeOperation = 'lighter'` while the player is
 * holding to make the trail visibly brighten.
 */
function paintTrailSprite(ctx: AnyCtx2D, lane: Lane): void {
  const fill = lane === 'L' ? THEME.laneL.fill : THEME.laneR.fill;
  const glow = lane === 'L' ? THEME.laneL.glow : THEME.laneR.glow;

  // 1. Fill the rounded-rect body so the gradient + caps sit cleanly inside it.
  ctx.beginPath();
  // Top cap.
  ctx.arc(TRAIL_WIDTH / 2, TRAIL_CAP_RADIUS, TRAIL_CAP_RADIUS, Math.PI, 0);
  // Right edge → bottom-right cap.
  ctx.lineTo(TRAIL_WIDTH, TRAIL_HEIGHT - TRAIL_CAP_RADIUS);
  ctx.arc(TRAIL_WIDTH / 2, TRAIL_HEIGHT - TRAIL_CAP_RADIUS, TRAIL_CAP_RADIUS, 0, Math.PI);
  // Left edge back to start.
  ctx.closePath();

  // 2. Lane-fill body with subtle vertical brightening toward the head end
  //    (top of the source bitmap; the renderer flips/positions so the head
  //    end sits at the hit-line side of the trail).
  const body = ctx.createLinearGradient(0, 0, TRAIL_WIDTH, 0);
  body.addColorStop(0, darkenHex(fill, 0.55));
  body.addColorStop(0.5, fill);
  body.addColorStop(1, darkenHex(fill, 0.55));
  ctx.fillStyle = body;
  ctx.fill();

  // 3. Edge-glow halo: a wider radial-style gradient overlay along the
  //    edges so the trail bleeds slightly outside its rounded-rect outline.
  //    Composite on top with `lighter` to additively brighten.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const glowGrad = ctx.createLinearGradient(0, 0, TRAIL_WIDTH, 0);
  glowGrad.addColorStop(0, glow);
  glowGrad.addColorStop(0.2, 'rgba(0,0,0,0)');
  glowGrad.addColorStop(0.8, 'rgba(0,0,0,0)');
  glowGrad.addColorStop(1, glow);
  ctx.fillStyle = glowGrad;
  ctx.fillRect(0, 0, TRAIL_WIDTH, TRAIL_HEIGHT);
  ctx.restore();
}

// ---- Public API -------------------------------------------------------------

/** Returns a pre-rendered drumhead sprite for the given lane (cached). */
export function getNoteSprite(lane: Lane): NoteSprite {
  const cached = laneSpriteCache.get(lane);
  if (cached) return cached;
  const sprite = buildSprite((ctx) => paintLaneSprite(ctx, lane), SPRITE_SIZE);
  laneSpriteCache.set(lane, sprite);
  return sprite;
}

/** Returns the Star-Power overlay sprite (cached). */
export function getSpOverlaySprite(): NoteSprite {
  if (spOverlayCache) return spOverlayCache;
  spOverlayCache = buildSprite(paintSpOverlay, SPRITE_SIZE);
  return spOverlayCache;
}

/**
 * Returns a pre-rendered sustain-trail sprite for the given lane (cached).
 * The renderer blits this between the head's centre and the trail-end point
 * on the highway. Width is fixed; the renderer scales the sprite uniformly
 * to track the head's perspective shrink. Sustain holds in progress
 * brighten the trail by overdrawing it with `globalCompositeOperation =
 * 'lighter'`; the base sprite itself is the "not held" appearance.
 */
export function getTrailSprite(lane: Lane): NoteSprite {
  const cached = trailSpriteCache.get(lane);
  if (cached) return cached;
  const sprite = buildSprite((ctx) => paintTrailSprite(ctx, lane), TRAIL_WIDTH, TRAIL_HEIGHT);
  trailSpriteCache.set(lane, sprite);
  return sprite;
}

// When the active palette changes (color-blind toggle), every cached sprite
// has the OLD lane colour baked into its bitmap. Drop the caches so the next
// `getNoteSprite` / `getSpOverlaySprite` / `getTrailSprite` call lazily
// rebuilds against the new palette. The first call (on subscribe) finds
// empty caches and is a no-op. Note: `notes.ts` separately tracks the
// palette epoch so its cached per-instance sprite handles also drop their
// stale references.
subscribePalette(() => {
  laneSpriteCache.clear();
  trailSpriteCache.clear();
  spOverlayCache = null;
});
