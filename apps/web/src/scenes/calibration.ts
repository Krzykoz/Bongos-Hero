/**
 * Latency calibration scene.
 *
 * A steady 100-BPM metronome plays through the synthesised SFX bank. The
 * player taps any left-side or right-side key in time. We measure each tap's
 * offset from the nearest
 * scheduled tick (in `performance.now()` units), drop wild misses, and
 * report the median once we have ≥ 3 valid taps. Save persists the median
 * via `saveAudioOffsetMs`; Cancel discards.
 *
 * Timing notes:
 *   - Tick scheduling uses `audioCtx.currentTime` (sample-accurate) for the
 *     audio side, but we also stash an estimated `performance.now()` time
 *     for each tick (computed from the wall-clock offset to ctx.currentTime
 *     captured at scheduling) so taps can be measured against a clock that
 *     shares units with the keyboard event timestamps.
 *   - We schedule a ~1 s lookahead of ticks every 250 ms.
 */

import './scenes.css';
import type { Scene, SceneContext } from '../router.js';
import { buildSfxBank, type SfxBank } from '../audio/sfxBank.js';
import { loadAudioOffsetMs, saveAudioOffsetMs } from '../audio/latency.js';
import { laneForCode } from '../input/sides.js';
import { el } from './dom.js';

interface WebkitWindow {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

function resolveAudioContextCtor(): typeof AudioContext {
  const w = window as unknown as WebkitWindow;
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) {
    throw new Error('Web Audio API is not supported in this environment.');
  }
  return Ctor;
}

const BEAT_INTERVAL_MS = 600;          // 100 BPM
const SCHEDULE_LOOKAHEAD_MS = 1_000;
const SCHEDULE_TICK_MS = 250;
const VALID_DELTA_MS = 250;
const FLASH_DURATION_MS = 140;

interface ScheduledTick {
  /** ctx.currentTime (s) at which the tick will fire / fired. */
  ctxTime: number;
  /** performance.now() estimate for the same tick. */
  perfTime: number;
  /** True once we've handed it to SfxEngine. */
  scheduled: boolean;
}

interface CalibrationState {
  ctx: AudioContext;
  sfx: SfxBank | null;
  ticks: ScheduledTick[];
  deltas: number[];
  schedulerTimer: number | null;
  rafId: number | null;
  /** ctx.currentTime when the metronome started, in seconds. */
  startCtxTime: number;
  /** Wall-clock offset: perfNow - ctxTimeMs at start. */
  perfMinusCtxMs: number;
  /** Current estimated offset (ms), or null until ≥ 3 valid taps. */
  currentOffsetMs: number | null;
  /** Index of the next un-scheduled beat. */
  nextBeatIndex: number;
}

let state: CalibrationState | null = null;
let root: HTMLDivElement | null = null;
let dotEl: HTMLDivElement | null = null;
let offsetValueEl: HTMLSpanElement | null = null;
let tapsValueEl: HTMLSpanElement | null = null;
let hintEl: HTMLDivElement | null = null;
let onKeyDown: ((ev: KeyboardEvent) => void) | null = null;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) {
    const v = sorted[mid];
    return v ?? 0;
  }
  const a = sorted[mid - 1] ?? 0;
  const b = sorted[mid] ?? 0;
  return (a + b) / 2;
}

function scheduleTicks(s: CalibrationState): void {
  if (!s.sfx) return;
  const horizonCtxMs = (s.ctx.currentTime + SCHEDULE_LOOKAHEAD_MS / 1000) * 1000;
  while (true) {
    const beatCtxMs = s.startCtxTime * 1000 + s.nextBeatIndex * BEAT_INTERVAL_MS;
    if (beatCtxMs > horizonCtxMs) break;
    const tick: ScheduledTick = {
      ctxTime: beatCtxMs / 1000,
      perfTime: beatCtxMs + s.perfMinusCtxMs,
      scheduled: false,
    };
    s.ticks.push(tick);
    // SfxEngine.play() doesn't accept a future startTime, so we rely on
    // setTimeout for the actual fire time. Audio jitter is dominated by
    // SFX latency, not this dispatcher; for a 100 BPM tick at 1.5 kHz it's
    // imperceptible. We use the audio clock for measurement, not playback.
    const delayMs = Math.max(0, beatCtxMs - s.ctx.currentTime * 1000);
    window.setTimeout(() => {
      if (state !== s) return;
      s.sfx?.engine.play('metronome-tick', { gain: 0.85 });
      flashDot();
    }, delayMs);
    tick.scheduled = true;
    s.nextBeatIndex++;
  }
}

function flashDot(): void {
  if (!dotEl) return;
  dotEl.classList.add('bh-cal-dot-on');
  window.setTimeout(() => {
    dotEl?.classList.remove('bh-cal-dot-on');
  }, FLASH_DURATION_MS);
}

function pruneOldTicks(s: CalibrationState, nowPerfMs: number): void {
  // Keep a small rolling window: anything older than 2 beats is useless.
  const cutoff = nowPerfMs - 2 * BEAT_INTERVAL_MS;
  while (s.ticks.length > 0) {
    const head = s.ticks[0];
    if (head !== undefined && head.perfTime < cutoff) {
      s.ticks.shift();
    } else {
      break;
    }
  }
}

function handleTap(s: CalibrationState, tapPerfMs: number): void {
  pruneOldTicks(s, tapPerfMs);
  // Find nearest tick by perfTime.
  let best: ScheduledTick | null = null;
  let bestAbs = Infinity;
  for (const t of s.ticks) {
    const d = Math.abs(tapPerfMs - t.perfTime);
    if (d < bestAbs) {
      bestAbs = d;
      best = t;
    }
  }
  if (!best) return;
  const delta = tapPerfMs - best.perfTime;
  if (Math.abs(delta) > VALID_DELTA_MS) return;
  s.deltas.push(delta);
  if (s.deltas.length >= 3) {
    s.currentOffsetMs = Math.round(median(s.deltas));
  }
  updateReadouts(s);
}

function updateReadouts(s: CalibrationState): void {
  if (tapsValueEl) tapsValueEl.textContent = String(s.deltas.length);
  if (offsetValueEl) {
    if (s.currentOffsetMs === null) {
      offsetValueEl.textContent = '— ms';
    } else {
      const sign = s.currentOffsetMs > 0 ? '+' : '';
      offsetValueEl.textContent = `${sign}${s.currentOffsetMs} ms`;
    }
  }
  if (hintEl) {
    if (s.deltas.length < 3) {
      hintEl.textContent = `Need at least 3 taps (have ${s.deltas.length}).`;
    } else {
      hintEl.textContent = 'Looking good — keep tapping for a tighter average.';
    }
  }
}

function reset(s: CalibrationState): void {
  s.deltas = [];
  s.currentOffsetMs = null;
  updateReadouts(s);
}

function teardown(): void {
  const s = state;
  state = null;
  if (s) {
    if (s.schedulerTimer !== null) {
      window.clearInterval(s.schedulerTimer);
      s.schedulerTimer = null;
    }
    if (s.rafId !== null) {
      cancelAnimationFrame(s.rafId);
      s.rafId = null;
    }
    // Closing the AudioContext releases the SfxEngine's master node + buffers.
    s.ctx.close().catch(() => {
      /* ignore */
    });
  }
  if (onKeyDown) {
    document.removeEventListener('keydown', onKeyDown);
    onKeyDown = null;
  }
  if (root) {
    root.remove();
    root = null;
  }
  dotEl = null;
  offsetValueEl = null;
  tapsValueEl = null;
  hintEl = null;
}

export const calibrationScene: Scene = {
  async enter(sceneCtx: SceneContext): Promise<void> {
    // Build DOM first so the user sees something even while the SFX bank
    // renders (it's fast — a handful of sub-second OfflineAudioContext jobs).
    dotEl = el('div', { className: 'bh-cal-dot' });
    offsetValueEl = el('span', { className: 'bh-cal-value' }, ['— ms']);
    tapsValueEl = el('span', { className: 'bh-cal-value' }, ['0']);
    hintEl = el('div', { className: 'bh-cal-hint' }, ['Need at least 3 taps (have 0).']);

    const saveBtn = el(
      'button',
      { type: 'button', className: 'bh-btn bh-btn-primary' },
      ['Save'],
    );
    const resetBtn = el(
      'button',
      { type: 'button', className: 'bh-btn' },
      ['Reset'],
    );
    const cancelBtn = el(
      'button',
      { type: 'button', className: 'bh-btn bh-btn-ghost' },
      ['Cancel'],
    );

    const card = el('div', { className: 'bh-cal-card' }, [
      el('h2', {}, ['Calibration']),
      el('p', {}, [
        'Tap any left or right key to the metronome. We\u2019ll measure your average ' +
          'offset and persist it as your audio-vs-video latency.',
      ]),
      dotEl,
      el('div', { className: 'bh-cal-stats' }, [
        el('div', { className: 'bh-cal-stat' }, [
          el('span', { className: 'bh-cal-label' }, ['Offset']),
          offsetValueEl,
        ]),
        el('div', { className: 'bh-cal-stat' }, [
          el('span', { className: 'bh-cal-label' }, ['Taps']),
          tapsValueEl,
        ]),
      ]),
      hintEl,
      el('div', { className: 'bh-cal-actions' }, [cancelBtn, resetBtn, saveBtn]),
    ]);
    root = el('div', { className: 'bh-cal-wrap' }, [card]);
    sceneCtx.overlay.appendChild(root);

    // Build audio context + SFX bank.
    let ctx: AudioContext;
    try {
      const Ctor = resolveAudioContextCtor();
      ctx = new Ctor();
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {
          /* ignore — caller already triggered a user gesture */
        }
      }
    } catch (err) {
      console.error('[calibration] AudioContext unavailable:', err);
      return;
    }

    let sfx: SfxBank | null = null;
    try {
      sfx = await buildSfxBank(ctx);
      sfx.engine.setMasterVolume(0.7);
    } catch (err) {
      console.warn('[calibration] buildSfxBank failed:', err);
    }

    // Capture the perf↔ctx clock relation as close as possible to the
    // moment we declare the metronome start time.
    const ctxNowMs = ctx.currentTime * 1000;
    const perfNowMs = performance.now();
    const startCtxTime = ctx.currentTime + 0.5; // half-second lead-in

    const s: CalibrationState = {
      ctx,
      sfx,
      ticks: [],
      deltas: [],
      schedulerTimer: null,
      rafId: null,
      startCtxTime,
      perfMinusCtxMs: perfNowMs - ctxNowMs,
      currentOffsetMs: null,
      nextBeatIndex: 0,
    };
    state = s;
    updateReadouts(s);

    // Pre-fill the persisted offset display so the user knows the baseline.
    const persisted = loadAudioOffsetMs();
    if (offsetValueEl && persisted !== 0) {
      const sign = persisted > 0 ? '+' : '';
      offsetValueEl.textContent = `${sign}${persisted} ms (saved)`;
    }

    scheduleTicks(s);
    s.schedulerTimer = window.setInterval(() => {
      if (state !== s) return;
      scheduleTicks(s);
    }, SCHEDULE_TICK_MS);

    saveBtn.addEventListener('click', () => {
      if (!state) return;
      const v = state.currentOffsetMs ?? 0;
      saveAudioOffsetMs(v);
      sceneCtx.navigate('title');
    });
    resetBtn.addEventListener('click', () => {
      if (!state) return;
      reset(state);
    });
    cancelBtn.addEventListener('click', () => {
      sceneCtx.navigate('title');
    });

    onKeyDown = (ev: KeyboardEvent): void => {
      const target = ev.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (ev.code === 'Escape') {
        ev.preventDefault();
        sceneCtx.navigate('title');
        return;
      }
      if (ev.code === 'Enter') {
        ev.preventDefault();
        if (!state) return;
        const v = state.currentOffsetMs ?? 0;
        saveAudioOffsetMs(v);
        sceneCtx.navigate('title');
        return;
      }
      if (ev.code === 'KeyR') {
        ev.preventDefault();
        if (state) reset(state);
        return;
      }
      // Any left-side or right-side key counts as a tap (consistent with
      // the in-game mash controls).
      if (laneForCode(ev.code) !== null) {
        ev.preventDefault();
        if (state) handleTap(state, performance.now());
      }
    };
    document.addEventListener('keydown', onKeyDown);
  },

  exit(sceneCtx: SceneContext): void {
    teardown();
    void sceneCtx;
  },

  draw(sceneCtx: SceneContext): void {
    // Paint a flat backdrop — no background renderer here, the DOM card
    // carries the whole scene. Keeping it simple avoids a stuck animation
    // bleeding through if the SFX bank is slow to load.
    const ctx = sceneCtx.ctx;
    ctx.save();
    ctx.fillStyle = '#0a0612';
    ctx.fillRect(0, 0, sceneCtx.canvas.width, sceneCtx.canvas.height);
    ctx.restore();
  },
};
