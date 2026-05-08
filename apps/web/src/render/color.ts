/**
 * Pure color helpers used by sprite / path painters.
 *
 * Both inputs are `#rrggbb` strings (the form `theme.ts` exposes). Outputs
 * are `rgb(r,g,b)` strings ready to drop into `ctx.fillStyle` /
 * `ctx.strokeStyle`. Side-effect-free and allocation-light so they're safe
 * to call from per-frame paint code.
 */

/**
 * Multiplicatively scale every channel of a `#rrggbb` colour toward black.
 * `factor < 1` darkens, `factor > 1` lightens (clamped at 255).
 */
export function darkenHex(hex: string, factor: number): string {
  const r = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(1, 3), 16) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(3, 5), 16) * factor)));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(5, 7), 16) * factor)));
  return `rgb(${r},${g},${b})`;
}

/**
 * Linearly blend a `#rrggbb` colour toward white by `factor` in `[0, 1]`.
 */
export function lightenHex(hex: string, factor: number): string {
  const r0 = parseInt(hex.slice(1, 3), 16);
  const g0 = parseInt(hex.slice(3, 5), 16);
  const b0 = parseInt(hex.slice(5, 7), 16);
  const r = Math.round(r0 + (255 - r0) * factor);
  const g = Math.round(g0 + (255 - g0) * factor);
  const b = Math.round(b0 + (255 - b0) * factor);
  return `rgb(${r},${g},${b})`;
}
