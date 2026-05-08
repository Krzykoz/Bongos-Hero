/**
 * Colour tokens for the Bongos Hero highway renderer.
 *
 * The palette leans into the PS2-era Guitar Hero 3 vibe: deep purple/violet
 * background, neon highway lines, and warm bongo-themed lane colours
 * (warm brown for the left bongo, cream for the right).
 *
 * Lane colours are split out into a {@link LanePalette} so the user-facing
 * "color-blind" toggle (see `settings/index.ts`) can swap the L/R colours to
 * a high-contrast, hue-distinguishable alternative without forcing every
 * downstream renderer to subscribe individually. Static (non-lane) tokens
 * live on {@link THEME} unchanged; the lane tokens forward to whichever
 * palette is currently active.
 */

import { subscribe, type Settings } from '../settings/index.js';

/** Per-lane colour set + Star-Power overlay tint. */
export interface LanePalette {
  L: { fill: string; glow: string; ringHit: string };
  R: { fill: string; glow: string; ringHit: string };
  /** Used for the screen-blend SP wash over the highway interior. */
  spOverlay: string;
}

/**
 * Default palette. Preserves the bongo-themed warm-brown / cream pairing the
 * game has shipped with — DO NOT change these unless the visual identity is
 * also being redesigned, since the no-`colorBlind` case must remain visually
 * identical to the pre-settings build.
 */
export const DEFAULT_PALETTE: LanePalette = {
  L: { fill: '#c97a3b', glow: 'rgba(255,168,98,0.7)', ringHit: '#ffd56a' },
  R: { fill: '#f0e0c0', glow: 'rgba(255,240,200,0.7)', ringHit: '#ffd56a' },
  spOverlay: 'rgba(120, 220, 255, 0.18)',
};

/**
 * High-contrast palette for red-green colour-blind players: cool blue (L) vs
 * warm amber (R). Both swatches are far apart in hue AND in luminance, so
 * they remain distinguishable under deuteranopia / protanopia simulations.
 * The SP overlay shifts to a violet so it does not collide with the amber R
 * lane.
 */
export const COLORBLIND_PALETTE: LanePalette = {
  L: { fill: '#3b82f6', glow: 'rgba(59,130,246,0.7)', ringHit: '#ffd56a' },
  R: { fill: '#f59e0b', glow: 'rgba(245,158,11,0.7)', ringHit: '#ffd56a' },
  spOverlay: 'rgba(168, 85, 247, 0.22)',
};

let activePalette: LanePalette = DEFAULT_PALETTE;
let paletteEpoch = 0;
const subscribers = new Set<(p: LanePalette) => void>();

/** Returns the palette currently in effect. Cheap; safe to call per-frame. */
export function getActivePalette(): LanePalette {
  return activePalette;
}

/**
 * Monotonically-incrementing counter bumped whenever the active palette
 * changes. Renderers that bake palette colours into expensive resources
 * (gradients, pre-rasterised sprite atlases) compare a cached epoch against
 * this value to decide whether to invalidate.
 */
export function getPaletteEpoch(): number {
  return paletteEpoch;
}

/**
 * Subscribe to palette changes. The callback is invoked SYNCHRONOUSLY with
 * the current palette on subscribe (mirrors `settings.subscribe`), so
 * callers can use the same code path for "apply once now" + "apply on
 * change". Returns an unsubscribe function.
 */
export function subscribePalette(cb: (p: LanePalette) => void): () => void {
  subscribers.add(cb);
  try {
    cb(activePalette);
  } catch (err) {
    console.error('[theme] subscriber threw on initial dispatch:', err);
  }
  return (): void => {
    subscribers.delete(cb);
  };
}

function setActivePalette(next: LanePalette): void {
  if (next === activePalette) return;
  activePalette = next;
  paletteEpoch++;
  // Snapshot before iterating so a callback that re-subscribes / unsubscribes
  // mid-iteration cannot mutate the live Set we're walking.
  const snapshot = Array.from(subscribers);
  for (const cb of snapshot) {
    try {
      cb(next);
    } catch (err) {
      console.error('[theme] subscriber threw:', err);
    }
  }
}

// Bridge: settings.colorBlind -> active palette. settings.subscribe runs the
// callback synchronously with the current settings on registration, so the
// active palette is correct from this module's first export onward.
subscribe((s: Settings) => {
  setActivePalette(s.colorBlind ? COLORBLIND_PALETTE : DEFAULT_PALETTE);
});

interface ThemeStaticTokens {
  bgTop: string;
  bgBottom: string;
  highwayEdge: string;
  highwayLine: string;
  laneDivider: string;
  hitLine: string;
  hitLineGlow: string;
}

const STATIC_TOKENS: ThemeStaticTokens = {
  bgTop: '#0a0612',
  bgBottom: '#1a0e22',
  highwayEdge: '#3a1d4e',
  highwayLine: '#5a2d77',
  laneDivider: 'rgba(255,255,255,0.10)',
  hitLine: '#f0e6ff',
  hitLineGlow: 'rgba(196,121,255,0.55)',
};

/**
 * Backward-compatible theme bag. The static (non-palette) tokens are plain
 * string properties; `laneL`, `laneR`, and `spOverlay` are getters that
 * forward to the currently-active {@link LanePalette}. Callers that read
 * those properties per-frame automatically see the new palette after a
 * settings change without having to subscribe themselves.
 */
export interface ThemeShape extends ThemeStaticTokens {
  readonly laneL: LanePalette['L'];
  readonly laneR: LanePalette['R'];
  readonly spOverlay: string;
}

export const THEME: ThemeShape = {
  ...STATIC_TOKENS,
  get laneL(): LanePalette['L'] {
    return activePalette.L;
  },
  get laneR(): LanePalette['R'] {
    return activePalette.R;
  },
  get spOverlay(): string {
    return activePalette.spOverlay;
  },
};
