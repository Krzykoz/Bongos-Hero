/**
 * Per-side bongo key sets — backed by user-customizable bindings from the
 * settings store (see `apps/web/src/settings/index.ts`).
 *
 * Goal: let the player slap any key bound to the left bongo for a left strike,
 * any key bound to the right bongo for a right strike, without breaking
 * normal browser/menu UX. The default bindings cover the entire left half of
 * the keyboard for left and the entire right half for right; deliberately
 * excluded by default:
 *   - Modifiers (Shift/Ctrl/Alt/Meta/CapsLock/Tab) so chords like Cmd+R still work.
 *   - Whitespace/navigation (Enter, Backspace, Escape, Space, arrows, page-nav).
 *   - Numpad and function keys (rare, often re-purposed by OS).
 *   - Insert/Delete/Home/End/PageUp/PageDown/ContextMenu.
 *
 * Space remains reserved for Star Power; Escape for pause.
 *
 * `LEFT_SIDE_KEYS` / `RIGHT_SIDE_KEYS` are LIVE Set instances: the same
 * references survive across rebinds, but their contents are replaced when
 * the user changes their bindings via the settings scene. Consumers can
 * therefore keep a single reference and always observe the current bindings
 * via `.has(code)`.
 *
 * Disjointness invariant: if a `KeyboardEvent.code` ends up in BOTH the user's
 * left and right lists (most likely a UI mishap), we keep it on the LEFT side
 * only — `laneForCode` returns `'L'` and the right Set never sees it. The UI
 * layer also tries to enforce disjointness, but this guard makes the runtime
 * behaviour deterministic regardless of how the lists were edited.
 */

import type { Lane } from '@bongos-hero/shared';

import { DEFAULTS, register, type KeyBindings } from '../settings/index.js';

const _leftKeys = new Set<string>();
const _rightKeys = new Set<string>();

export const LEFT_SIDE_KEYS: ReadonlySet<string> = _leftKeys;
export const RIGHT_SIDE_KEYS: ReadonlySet<string> = _rightKeys;

function rebuildSets(keys: KeyBindings): void {
  _leftKeys.clear();
  _rightKeys.clear();

  // Defensive fallback: if the settings store somehow handed us empty lists
  // (it shouldn't — settings/index.ts normalises empties back to DEFAULTS),
  // fall back to the stock physical-half mash sets so the game stays playable.
  const leftSrc = keys.left.length > 0 ? keys.left : DEFAULTS.keys.left;
  const rightSrc = keys.right.length > 0 ? keys.right : DEFAULTS.keys.right;

  for (const code of leftSrc) _leftKeys.add(code);
  // Disjointness preference: a code in BOTH lists is treated as LEFT only.
  for (const code of rightSrc) {
    if (!_leftKeys.has(code)) _rightKeys.add(code);
  }
}

// Register a per-key applier at module init. `register('keys', ...)` invokes
// the applier synchronously with the current bindings, so by the time this
// call returns the Sets are populated. Volume / colorBlind / etc. changes
// no longer wake this path up — only an actual rebind triggers a rebuild.
register('keys', (keys) => {
  rebuildSets(keys);
});

export function laneForCode(code: string): Lane | null {
  if (_leftKeys.has(code)) return 'L';
  if (_rightKeys.has(code)) return 'R';
  return null;
}
