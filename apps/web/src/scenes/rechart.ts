/**
 * Re-chart scene.
 *
 * Three sliders + Re-chart / Cancel buttons. Submitting POSTs to
 * `/api/rechart` with the slider values and the songId picked up from the
 * scene-enter payload; the server re-runs `buildChart` against the cached
 * audio analysis, persists the new chart, and we navigate back to song-select
 * so the next play uses it.
 *
 * Defaults match `DEFAULT_TUNABLES` on the server (`apps/server/src/chart.ts`).
 * If those literals change there, mirror them here so the slider initial
 * positions stay aligned with the auto-import baseline.
 */

import './scenes.css';
import './rechart.css';
import type { ChartV1 } from '@bongos-hero/shared';
import type { Scene, SceneContext } from '../router.js';
import { clear, el } from './dom.js';
import { BackgroundRenderer } from '../render/background.js';

interface RechartTunables {
  rmsFloor: number;
  minSpacingMs: number;
  centroidThreshold: number;
}

interface RechartPayload {
  songId?: unknown;
}

interface SliderSpec {
  key: keyof RechartTunables;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  format(value: number): string;
}

// Mirror of DEFAULT_TUNABLES in apps/server/src/chart.ts. Keep in sync.
const DEFAULT_TUNABLES: RechartTunables = {
  rmsFloor: 0.005,
  minSpacingMs: 90,
  centroidThreshold: 1500,
};

const SLIDERS: readonly SliderSpec[] = [
  {
    key: 'rmsFloor',
    label: 'RMS Floor',
    description: 'Drop quiet onsets below this energy level. Higher = sparser chart.',
    min: 0.001,
    max: 0.05,
    step: 0.001,
    format: (v) => v.toFixed(3),
  },
  {
    key: 'minSpacingMs',
    label: 'Min Spacing',
    description: 'Minimum gap between any two notes. Higher = more breathing room.',
    min: 60,
    max: 200,
    step: 5,
    format: (v) => `${Math.round(v)} ms`,
  },
  {
    key: 'centroidThreshold',
    label: 'Centroid Threshold',
    description: 'Spectral centroid (Hz) splitting low (L) from high (R) lanes.',
    min: 1500,
    max: 3000,
    step: 50,
    format: (v) => `${Math.round(v)} Hz`,
  },
];

let bg: BackgroundRenderer | null = null;
let root: HTMLDivElement | null = null;
let onKeyDown: ((ev: KeyboardEvent) => void) | null = null;
let songId: string | null = null;
let tunables: RechartTunables = { ...DEFAULT_TUNABLES };
let submitBtn: HTMLButtonElement | null = null;
let cancelBtn: HTMLButtonElement | null = null;
let resetBtn: HTMLButtonElement | null = null;
let statusEl: HTMLDivElement | null = null;
let spinnerEl: HTMLDivElement | null = null;
let sliderInputs: HTMLInputElement[] = [];
let sliderReadouts: HTMLSpanElement[] = [];
let busy = false;

function ensureBackground(): BackgroundRenderer {
  if (!bg) {
    bg = new BackgroundRenderer();
    bg.setBpm(120);
  }
  return bg;
}

function clamp(min: number, max: number, v: number): number {
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function setStatus(msg: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  if (!statusEl) return;
  statusEl.className =
    kind === 'error'
      ? 'bh-rechart-status bh-error'
      : kind === 'success'
        ? 'bh-rechart-status bh-success'
        : 'bh-rechart-status';
  statusEl.textContent = msg;
}

function setBusy(b: boolean): void {
  busy = b;
  if (submitBtn) {
    submitBtn.disabled = b;
    submitBtn.textContent = b ? 'Re-charting…' : 'Re-chart';
  }
  if (cancelBtn) cancelBtn.disabled = b;
  if (resetBtn) resetBtn.disabled = b;
  for (const input of sliderInputs) {
    input.disabled = b;
  }
  if (spinnerEl) {
    spinnerEl.style.display = b ? 'block' : 'none';
  }
}

function buildSliderRow(spec: SliderSpec): HTMLDivElement {
  const value = tunables[spec.key];
  const readout = el('span', { className: 'bh-rechart-readout' }, [spec.format(value)]);
  const labelText = el('span', { className: 'bh-rechart-label-text' }, [spec.label]);
  const header = el('div', { className: 'bh-rechart-row-header' }, [labelText, readout]);

  const input = el('input', {
    type: 'range',
    className: 'bh-rechart-slider',
    min: String(spec.min),
    max: String(spec.max),
    step: String(spec.step),
    value: String(value),
  });

  input.addEventListener('input', () => {
    const raw = Number.parseFloat(input.value);
    const clamped = clamp(spec.min, spec.max, raw);
    tunables[spec.key] = clamped;
    input.value = String(clamped);
    readout.textContent = spec.format(clamped);
  });

  sliderInputs.push(input);
  sliderReadouts.push(readout);

  const desc = el('span', { className: 'bh-rechart-desc' }, [spec.description]);
  return el('label', { className: 'bh-rechart-row' }, [
    header,
    input,
    desc,
  ]) as unknown as HTMLDivElement;
}

function resetSliders(): void {
  tunables = { ...DEFAULT_TUNABLES };
  SLIDERS.forEach((spec, i) => {
    const value = tunables[spec.key];
    const input = sliderInputs[i];
    const readout = sliderReadouts[i];
    if (input) input.value = String(value);
    if (readout) readout.textContent = spec.format(value);
  });
}

interface RechartResponse {
  chart: ChartV1;
}

async function postRechart(id: string, payload: RechartTunables): Promise<RechartResponse> {
  const res = await fetch('/api/rechart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ songId: id, ...payload }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string' && body.error.length > 0) {
        detail = body.error;
      }
    } catch {
      // Body might be empty or non-JSON — fall through.
    }
    throw new Error(detail);
  }
  return (await res.json()) as RechartResponse;
}

async function onSubmit(sceneCtx: SceneContext): Promise<void> {
  if (busy) return;
  if (!songId) {
    setStatus('No song selected.', 'error');
    return;
  }
  setBusy(true);
  setStatus('Re-running chart pipeline (onsets + features + lane classification)…', 'info');
  try {
    await postRechart(songId, tunables);
    setStatus('Chart updated. Returning to song select…', 'success');
    window.setTimeout(() => sceneCtx.navigate('songSelect'), 600);
  } catch (err) {
    console.error('[rechart] submit failed:', err);
    const msg = err instanceof Error ? err.message : 'unknown error';
    setStatus(`Re-chart failed: ${msg}`, 'error');
    setBusy(false);
  }
}

export const rechartScene: Scene = {
  enter(sceneCtx: SceneContext): void {
    ensureBackground();

    const payload = (sceneCtx.payload ?? {}) as RechartPayload;
    songId =
      typeof payload.songId === 'string' && payload.songId.length > 0 ? payload.songId : null;

    tunables = { ...DEFAULT_TUNABLES };
    sliderInputs = [];
    sliderReadouts = [];
    busy = false;

    submitBtn = el('button', { type: 'button', className: 'bh-btn bh-btn-primary' }, ['Re-chart']);
    cancelBtn = el('button', { type: 'button', className: 'bh-btn bh-btn-ghost' }, ['Cancel']);
    resetBtn = el('button', { type: 'button', className: 'bh-btn' }, ['Reset']);
    statusEl = el('div', { className: 'bh-rechart-status' }, [
      songId === null
        ? 'No song selected. Press Cancel to return.'
        : 'Adjust the sliders and press Re-chart.',
    ]);
    spinnerEl = el('div', { className: 'bh-rechart-spinner' });
    spinnerEl.style.display = 'none';

    submitBtn.addEventListener('click', () => {
      void onSubmit(sceneCtx);
    });
    cancelBtn.addEventListener('click', () => {
      sceneCtx.navigate('songSelect');
    });
    resetBtn.addEventListener('click', () => {
      if (busy) return;
      resetSliders();
    });

    const rows: HTMLDivElement[] = SLIDERS.map((s) => buildSliderRow(s));

    const card = el('div', { className: 'bh-rechart-card' }, [
      el('h2', {}, ['Re-chart']),
      el('p', {}, [
        'Re-runs the chart pipeline against the cached audio analysis with ' +
          'these tunables. Existing chart will be overwritten.',
      ]),
      el('div', { className: 'bh-rechart-rows' }, rows),
      spinnerEl,
      statusEl,
      el('div', { className: 'bh-rechart-actions' }, [cancelBtn, resetBtn, submitBtn]),
    ]);

    root = el('div', { className: 'bh-rechart-wrap' }, [card]);
    sceneCtx.overlay.appendChild(root);

    if (songId === null) {
      setBusy(true);
      // Keep cancel usable so the user can leave.
      if (cancelBtn) cancelBtn.disabled = false;
    }

    onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.repeat) return;
      const target = ev.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (ev.code === 'Escape') {
        ev.preventDefault();
        sceneCtx.navigate('songSelect');
        return;
      }
      if (ev.code === 'Enter' && !busy && songId !== null) {
        if (target instanceof HTMLInputElement && target.type === 'range') {
          // Slider Enter would otherwise reset the value; consume it.
          ev.preventDefault();
          void onSubmit(sceneCtx);
          return;
        }
        if (
          !(target instanceof HTMLElement) ||
          (target.tagName !== 'INPUT' && target.tagName !== 'BUTTON')
        ) {
          ev.preventDefault();
          void onSubmit(sceneCtx);
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
  },

  exit(sceneCtx: SceneContext): void {
    if (onKeyDown) {
      document.removeEventListener('keydown', onKeyDown);
      onKeyDown = null;
    }
    if (root) {
      clear(root);
      root.remove();
      root = null;
    }
    submitBtn = null;
    cancelBtn = null;
    resetBtn = null;
    statusEl = null;
    spinnerEl = null;
    sliderInputs = [];
    sliderReadouts = [];
    songId = null;
    busy = false;
    void sceneCtx;
  },

  draw(sceneCtx: SceneContext, nowMs: number): void {
    ensureBackground().draw(sceneCtx.ctx, { nowMs });
  },
};
