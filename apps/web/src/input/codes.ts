/**
 * Physical key codes used by the keyboard input layer.
 *
 * Bongo lanes accept any key bound to the corresponding side via the user
 * settings (see ./sides.ts and `apps/web/src/settings/index.ts`). These
 * `KEY_*` constants name the *canonical* / default keys used by menu scenes
 * that still want a single "select" key per side; they are static and do
 * NOT follow user rebinds — for dynamic per-side classification call
 * `laneForCode(code)` or query `LEFT_SIDE_KEYS` / `RIGHT_SIDE_KEYS`, both
 * of which reflect the live settings.
 *
 * We deliberately use `KeyboardEvent.code` values (which describe the physical
 * key position on a US-QWERTY-style layout) rather than `KeyboardEvent.key`
 * values (which depend on the active layout). This keeps the bongo positions
 * the same on AZERTY, Dvorak, etc.
 *
 * `LEFT_SIDE_KEYS` / `RIGHT_SIDE_KEYS` are re-exported from `./sides.js`;
 * they are LIVE Sets backed by the settings store, populated at module init
 * via `subscribe(...)` and rebuilt whenever the user rebinds.
 */

/** Canonical left-bongo key (used by menus as a "confirm" alias). */
export const KEY_LEFT = 'KeyF';

/** Canonical right-bongo key (used by menus as a "confirm" alias). */
export const KEY_RIGHT = 'KeyJ';

/** Activate Star Power. */
export const KEY_STARPOWER = 'Space';

/** Pause / resume. */
export const KEY_PAUSE = 'Escape';

export { LEFT_SIDE_KEYS, RIGHT_SIDE_KEYS, laneForCode } from './sides.js';
