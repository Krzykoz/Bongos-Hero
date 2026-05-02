/**
 * Colour tokens for the Bongos Hero highway renderer.
 *
 * The palette leans into the PS2-era Guitar Hero 3 vibe: deep purple/violet
 * background, neon highway lines, and warm bongo-themed lane colours
 * (warm brown for the left bongo, cream for the right).
 */

export const THEME = {
  bgTop: '#0a0612',
  bgBottom: '#1a0e22',
  highwayEdge: '#3a1d4e',
  highwayLine: '#5a2d77',
  laneDivider: 'rgba(255,255,255,0.10)',
  hitLine: '#f0e6ff',
  hitLineGlow: 'rgba(196,121,255,0.55)',
  laneL: { fill: '#c97a3b', glow: 'rgba(255,168,98,0.7)' },
  laneR: { fill: '#f0e0c0', glow: 'rgba(255,240,200,0.7)' },
  spOverlay: 'rgba(120, 220, 255, 0.18)',
} as const;
