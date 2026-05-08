import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULTS, saveSettings } from '../../settings/index.js';
import { laneForCode, LEFT_SIDE_KEYS, RIGHT_SIDE_KEYS } from '../sides.js';

describe('laneForCode', () => {
  it.each([
    'Backquote',
    'Digit1',
    'Digit5',
    'KeyQ',
    'KeyT',
    'KeyA',
    'KeyG',
    'KeyZ',
    'KeyV',
    'KeyB',
  ])('left-half code %s → "L"', (code) => {
    expect(laneForCode(code)).toBe('L');
  });

  it.each([
    'Digit6',
    'Digit0',
    'Minus',
    'Equal',
    'KeyY',
    'KeyP',
    'BracketLeft',
    'KeyH',
    'KeyL',
    'Semicolon',
    'Quote',
    'KeyN',
    'KeyM',
    'Slash',
  ])('right-half code %s → "R"', (code) => {
    expect(laneForCode(code)).toBe('R');
  });

  it.each([
    'Space', // reserved for Star Power
    'Enter',
    'Escape', // reserved for pause
    'Tab',
    'ShiftLeft',
    'ShiftRight',
    'ControlLeft',
    'AltLeft',
    'MetaLeft',
    'CapsLock',
    'Backspace',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'PageUp',
    'PageDown',
    'Home',
    'End',
    'Insert',
    'Delete',
    'Numpad0',
    'NumpadEnter',
    'F1',
    'F12',
    'ContextMenu',
  ])('non-letter / modifier %s → null', (code) => {
    expect(laneForCode(code)).toBeNull();
  });

  it('left and right key sets are disjoint', () => {
    for (const code of LEFT_SIDE_KEYS) {
      expect(RIGHT_SIDE_KEYS.has(code)).toBe(false);
    }
  });
});

/**
 * Custom-binding tests: drive the settings store directly (vitest runs in
 * a Node env without `localStorage`, so `saveSettings` simply mutates the
 * in-memory store and synchronously fans out to the `subscribe`d `sides.ts`
 * module). Each test restores defaults in `afterEach` so we don't leak
 * state into the suite above.
 */
describe('custom bindings', () => {
  afterEach(() => {
    saveSettings({
      keys: { left: [...DEFAULTS.keys.left], right: [...DEFAULTS.keys.right] },
    });
  });

  it('classifies user-bound keys per their side and ignores everything else', () => {
    saveSettings({ keys: { left: ['KeyA'], right: ['KeyL'] } });
    expect(laneForCode('KeyA')).toBe('L');
    expect(laneForCode('KeyL')).toBe('R');
    // Old defaults are no longer in either list.
    expect(laneForCode('KeyF')).toBeNull();
    expect(laneForCode('KeyJ')).toBeNull();
    // The live Sets reflect the rebind too — they aren't snapshots.
    expect(LEFT_SIDE_KEYS.has('KeyA')).toBe(true);
    expect(RIGHT_SIDE_KEYS.has('KeyL')).toBe(true);
    expect(LEFT_SIDE_KEYS.size).toBe(1);
    expect(RIGHT_SIDE_KEYS.size).toBe(1);
  });

  it('reset to defaults restores the physical-half heuristic', () => {
    saveSettings({ keys: { left: ['KeyA'], right: ['KeyL'] } });
    expect(laneForCode('KeyF')).toBeNull();

    saveSettings({
      keys: { left: [...DEFAULTS.keys.left], right: [...DEFAULTS.keys.right] },
    });
    expect(laneForCode('KeyF')).toBe('L');
    expect(laneForCode('KeyJ')).toBe('R');
    expect(laneForCode('Backquote')).toBe('L');
    expect(laneForCode('Slash')).toBe('R');
  });

  it('settings updates trigger re-classification on the next call (live subscribe)', () => {
    saveSettings({ keys: { left: ['KeyA'], right: ['KeyL'] } });
    expect(laneForCode('KeyA')).toBe('L');
    expect(laneForCode('KeyB')).toBeNull();

    saveSettings({ keys: { left: ['KeyB'], right: ['KeyM'] } });
    expect(laneForCode('KeyA')).toBeNull();
    expect(laneForCode('KeyB')).toBe('L');
    expect(laneForCode('KeyM')).toBe('R');
    expect(laneForCode('KeyL')).toBeNull();
  });

  it('disjointness preference: a key in BOTH lists is classified as L only', () => {
    saveSettings({ keys: { left: ['KeyA'], right: ['KeyA', 'KeyL'] } });
    expect(laneForCode('KeyA')).toBe('L');
    expect(laneForCode('KeyL')).toBe('R');
    expect(LEFT_SIDE_KEYS.has('KeyA')).toBe(true);
    expect(RIGHT_SIDE_KEYS.has('KeyA')).toBe(false);
  });

  it('empty / invalid persisted lists fall back to defaults at the settings layer', () => {
    // saveSettings({}) with an empty list should not wipe out the bindings
    // — the normalize() pass in settings/index.ts replaces empty arrays with
    // the stock defaults so the game stays playable.
    saveSettings({ keys: { left: [], right: [] } });
    expect(laneForCode('KeyF')).toBe('L');
    expect(laneForCode('KeyJ')).toBe('R');
  });
});
