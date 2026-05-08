/**
 * Settings scene.
 *
 * Single panel with sliders for music volume, SFX volume, and the scroll-speed
 * multiplier, a checkbox for the color-blind palette, and a Key Bindings
 * editor for the left + right bongo lists. Every control's `input`/`click`
 * event calls `saveSettings({...})`, which persists to localStorage AND
 * notifies the audio engines + input layer via their settings subscriptions —
 * so volume sliders attenuate playback live and key rebinds take effect on
 * the next press without `play.ts` needing to know about it.
 *
 * Esc returns to the title screen — except while a key-capture is in
 * progress, in which case Esc cancels the capture instead.
 */

import './scenes.css';
import './settings.css';
import type { Scene, SceneContext } from '../router.js';
import { clear, el } from './dom.js';
import {
  DEFAULTS,
  loadSettings,
  saveSettings,
  subscribe,
  type Settings,
} from '../settings/index.js';

interface SliderSpec {
  key: 'musicVolume' | 'sfxVolume' | 'scrollSpeedMul';
  label: string;
  min: number;
  max: number;
  step: number;
  format(value: number): string;
}

const SLIDERS: readonly SliderSpec[] = [
  {
    key: 'musicVolume',
    label: 'Music Volume',
    min: 0,
    max: 1,
    step: 0.01,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'sfxVolume',
    label: 'SFX Volume',
    min: 0,
    max: 1,
    step: 0.01,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'scrollSpeedMul',
    label: 'Scroll Speed',
    min: 0.5,
    max: 2.0,
    step: 0.05,
    format: (v) => `${v.toFixed(2)}×`,
  },
];

let root: HTMLDivElement | null = null;
let onKeyDown: ((ev: KeyboardEvent) => void) | null = null;
let captureCancel: (() => void) | null = null;
const settingsCleanups: (() => void)[] = [];

/**
 * Modifier-only / lock keys that we never want to bind on their own — they
 * arrive as standalone keydown events but are conceptually meaningless as a
 * bongo input. Cancels the capture instead of recording them.
 */
const MODIFIER_ONLY_CODES: ReadonlySet<string> = new Set<string>([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
  'NumLock',
  'ScrollLock',
]);

function clamp(min: number, max: number, v: number): number {
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function buildSliderRow(spec: SliderSpec, initial: Settings): HTMLDivElement {
  const value = initial[spec.key];
  const readout = el('span', { className: 'bh-set-readout' }, [spec.format(value)]);
  const labelText = el('span', { className: 'bh-set-label-text' }, [spec.label]);
  const header = el('div', { className: 'bh-set-row-header' }, [labelText, readout]);

  const input = el('input', {
    type: 'range',
    className: 'bh-set-slider',
    min: String(spec.min),
    max: String(spec.max),
    step: String(spec.step),
    value: String(value),
  });

  input.addEventListener('input', () => {
    const raw = Number.parseFloat(input.value);
    const clamped = clamp(spec.min, spec.max, raw);
    const next = saveSettings({ [spec.key]: clamped });
    // Keep the slider visually consistent with the persisted (clamped) value
    // in case the input emitted something out of range.
    input.value = String(next[spec.key]);
    readout.textContent = spec.format(next[spec.key]);
  });

  return el('label', { className: 'bh-set-row' }, [header, input]) as unknown as HTMLDivElement;
}

function buildColorBlindRow(initial: Settings): HTMLDivElement {
  const checkbox = el('input', {
    type: 'checkbox',
    className: 'bh-set-checkbox',
    checked: initial.colorBlind,
  });
  const labelText = el('span', { className: 'bh-set-label-text' }, ['Color-Blind Palette']);
  checkbox.addEventListener('input', () => {
    saveSettings({ colorBlind: checkbox.checked });
  });
  return el('label', { className: 'bh-set-row bh-set-row-toggle' }, [
    labelText,
    checkbox,
  ]) as unknown as HTMLDivElement;
}

/**
 * End any in-flight key-capture without recording a key. Safe to call
 * multiple times; safe to call when no capture is active.
 */
function endCapture(): void {
  if (captureCancel) {
    const fn = captureCancel;
    captureCancel = null;
    fn();
  }
}

/**
 * Build a key-bindings row for the given side. The row has:
 *   - a side label (Left / Right)
 *   - a row of `<kbd>` chips, each with a × button to remove that single key
 *     (the × is disabled when only one key remains, so the list never
 *     becomes empty — empty lists fall back to defaults at the settings
 *     layer, which would silently undo the player's intent)
 *   - an "Add Key" button that captures the next physical key press
 *     (Esc cancels)
 *   - a "Reset" button that restores `DEFAULTS.keys[side]`
 *
 * Subscribes to the settings store so external changes (or sibling
 * row edits, when the same key is moved across sides) re-render the chips.
 */
function buildKeyBindingRow(side: 'left' | 'right'): HTMLDivElement {
  const sideLabel = side === 'left' ? 'Left Bongo' : 'Right Bongo';

  const labelText = el('span', { className: 'bh-set-label-text' }, [sideLabel]);
  const resetBtn = el(
    'button',
    {
      type: 'button',
      className: 'bh-set-key-reset',
      title: `Reset ${sideLabel} bindings to defaults`,
    },
    ['Reset'],
  );
  resetBtn.addEventListener('click', () => {
    endCapture();
    const current = loadSettings().keys;
    const fresh = [...DEFAULTS.keys[side]];
    saveSettings({ keys: { ...current, [side]: fresh } });
  });

  const header = el('div', { className: 'bh-set-row-header' }, [labelText, resetBtn]);

  const chips = el('div', { className: 'bh-set-key-chips' });
  const addBtn = el(
    'button',
    {
      type: 'button',
      className: 'bh-set-key-add',
    },
    ['+ Add Key'],
  );

  function renderChips(s: Settings): void {
    clear(chips);
    const keys = s.keys[side];
    const canRemove = keys.length > 1;
    for (const code of keys) {
      const chip = el('span', { className: 'bh-set-key-chip' });
      chip.appendChild(el('kbd', { className: 'bh-set-key-kbd' }, [code]));
      const remove = el(
        'button',
        {
          type: 'button',
          className: 'bh-set-key-remove',
          title: canRemove ? `Remove ${code}` : 'At least one key must remain',
          disabled: !canRemove,
        },
        ['×'],
      );
      remove.addEventListener('click', () => {
        endCapture();
        const current = loadSettings().keys;
        const next = current[side].filter((c) => c !== code);
        if (next.length === 0) return; // safety — disabled button should prevent this
        saveSettings({ keys: { ...current, [side]: next } });
      });
      chip.appendChild(remove);
      chips.appendChild(chip);
    }
  }

  function startCapture(): void {
    if (captureCancel) {
      // Another row is already capturing — cancel it first so we never have
      // two listeners fighting over the same keydown.
      endCapture();
    }
    addBtn.classList.add('bh-set-key-add-listening');
    addBtn.textContent = 'Press a key… (Esc to cancel)';

    const handler = (ev: KeyboardEvent): void => {
      if (ev.repeat) return;
      // Always own the keydown so the underlying scene Esc handler / bongo
      // input layer can't consume it while we're listening.
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();

      if (ev.code === 'Escape') {
        finish();
        return;
      }
      if (ev.ctrlKey || ev.altKey || ev.metaKey) {
        // Refuse to bind a modifier-held chord — these collide with
        // browser shortcuts (Cmd+R, Ctrl+T, Alt+Tab, …). Cancel instead.
        finish();
        return;
      }
      if (MODIFIER_ONLY_CODES.has(ev.code)) {
        // Ignore the standalone modifier press but keep listening — the
        // user almost certainly meant to combine it with a real key.
        return;
      }

      const current = loadSettings().keys;
      const list = current[side];
      const otherSide: 'left' | 'right' = side === 'left' ? 'right' : 'left';
      const otherList = current[otherSide].filter((c) => c !== ev.code);
      const nextList = list.includes(ev.code) ? list : [...list, ev.code];
      // Only persist when something actually changed (avoid spurious
      // subscriber notifications).
      if (nextList !== list || otherList.length !== current[otherSide].length) {
        saveSettings({ keys: { ...current, [side]: nextList, [otherSide]: otherList } });
      }
      finish();
    };

    function finish(): void {
      document.removeEventListener('keydown', handler, true);
      addBtn.classList.remove('bh-set-key-add-listening');
      addBtn.textContent = '+ Add Key';
      if (captureCancel === finish) captureCancel = null;
    }

    captureCancel = finish;
    document.addEventListener('keydown', handler, true);
  }

  addBtn.addEventListener('click', startCapture);

  // Initial render + live re-render on settings changes.
  const unsub = subscribe(renderChips);
  settingsCleanups.push(unsub);

  return el('div', { className: 'bh-set-row bh-set-row-keys' }, [header, chips, addBtn]);
}

export const settingsScene: Scene = {
  enter(sceneCtx: SceneContext): void {
    const initial = loadSettings();

    const rows: HTMLDivElement[] = SLIDERS.map((s) => buildSliderRow(s, initial));
    rows.push(buildColorBlindRow(initial));
    rows.push(buildKeyBindingsSection());

    const hint = el('div', { className: 'bh-set-hint' }, ['Press Esc to return to the title.']);

    const card = el('div', { className: 'bh-set-card' }, [
      el('h2', {}, ['Settings']),
      el('div', { className: 'bh-set-rows' }, rows),
      hint,
    ]);
    root = el('div', { className: 'bh-set-wrap' }, [card]);
    sceneCtx.overlay.appendChild(root);

    onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.repeat) return;
      const target = ev.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        // Don't steal Esc from a text input — but the inputs in this scene
        // are <input type="range"> / <input type="checkbox">, which don't
        // consume Esc, so we still want to handle it for them.
        if (
          target instanceof HTMLInputElement &&
          (target.type === 'range' || target.type === 'checkbox')
        ) {
          // fall through
        } else {
          return;
        }
      }
      if (ev.code === 'Escape') {
        ev.preventDefault();
        sceneCtx.navigate('title');
      }
    };
    document.addEventListener('keydown', onKeyDown);
  },

  exit(sceneCtx: SceneContext): void {
    endCapture();
    if (onKeyDown) {
      document.removeEventListener('keydown', onKeyDown);
      onKeyDown = null;
    }
    while (settingsCleanups.length > 0) {
      const fn = settingsCleanups.pop();
      if (fn) fn();
    }
    if (root) {
      root.remove();
      root = null;
    }
    void sceneCtx;
  },

  draw(sceneCtx: SceneContext): void {
    const ctx = sceneCtx.ctx;
    ctx.save();
    ctx.fillStyle = '#0a0612';
    ctx.fillRect(0, 0, sceneCtx.canvas.width, sceneCtx.canvas.height);
    ctx.restore();
  },
};

function buildKeyBindingsSection(): HTMLDivElement {
  const heading = el('div', { className: 'bh-set-section-heading' }, ['Key Bindings']);
  const sub = el('div', { className: 'bh-set-section-sub' }, [
    'Click + Add Key, then press any key to bind it to that bongo.',
  ]);
  return el('div', { className: 'bh-set-keys-section' }, [
    heading,
    sub,
    buildKeyBindingRow('left'),
    buildKeyBindingRow('right'),
  ]);
}
