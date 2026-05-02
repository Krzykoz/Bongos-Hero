/**
 * Physical "left side" / "right side" key sets for the keyboard mash input.
 *
 * Goal: let the player slap the entire left half of the keyboard for the
 * left bongo and the entire right half for the right bongo, without breaking
 * normal browser/menu UX. We deliberately exclude:
 *   - Modifiers (Shift/Ctrl/Alt/Meta/CapsLock/Tab) so chords like Cmd+R still work.
 *   - Whitespace/navigation (Enter, Backspace, Escape, Space, arrows, page-nav).
 *   - Numpad and function keys (rare, often re-purposed by OS).
 *   - Insert/Delete/Home/End/PageUp/PageDown/ContextMenu.
 *
 * Space remains reserved for Star Power; Escape for pause.
 */

import type { Lane } from '@bongos-hero/shared';

export const LEFT_SIDE_KEYS: ReadonlySet<string> = new Set<string>([
  'Backquote',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'KeyQ',
  'KeyW',
  'KeyE',
  'KeyR',
  'KeyT',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyF',
  'KeyG',
  'KeyZ',
  'KeyX',
  'KeyC',
  'KeyV',
  'KeyB',
]);

export const RIGHT_SIDE_KEYS: ReadonlySet<string> = new Set<string>([
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Digit0',
  'Minus',
  'Equal',
  'KeyY',
  'KeyU',
  'KeyI',
  'KeyO',
  'KeyP',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'KeyH',
  'KeyJ',
  'KeyK',
  'KeyL',
  'Semicolon',
  'Quote',
  'KeyN',
  'KeyM',
  'Comma',
  'Period',
  'Slash',
]);

export function laneForCode(code: string): Lane | null {
  if (LEFT_SIDE_KEYS.has(code)) return 'L';
  if (RIGHT_SIDE_KEYS.has(code)) return 'R';
  return null;
}
