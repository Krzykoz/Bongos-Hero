/**
 * Mini chart timeline used by the re-chart preview.
 *
 * Renders a scrub-bar-style overview of every note in a `ChartV1` onto a
 * small `<canvas>`: each note is a thin vertical tick coloured by lane,
 * sustains extend the tick into a horizontal bar to `tMs + durMs`, and
 * Star-Power notes are tinted gold. The horizontal axis is linear time from
 * 0 to the song duration (derived from the chart's last note + last sustain
 * trail when no explicit duration is supplied).
 *
 * The component returns a tiny `{ root, render, dispose }` triple so the
 * caller can drop the root into the DOM, re-render with a new chart on
 * every preview, and tear down without leaking the resize observer.
 */

import type { ChartV1 } from '@bongos-hero/shared';

import { getActivePalette, subscribePalette } from './theme.js';

export interface ChartTimelineHandle {
  /** Root element to attach to the DOM. */
  root: HTMLDivElement;
  /**
   * Re-render with a new chart. Pass `null` to clear (placeholder mode).
   * `durationMs` is optional; falls back to the chart's last-note end time.
   */
  render(chart: ChartV1 | null, durationMs?: number): void;
  /** Detach observers / palette subscription. */
  dispose(): void;
}

interface TimelineState {
  chart: ChartV1 | null;
  durationMs: number;
}

const TIMELINE_HEIGHT = 60;
const TIMELINE_PAD_X = 8;
const TIMELINE_PAD_Y = 8;
const TICK_WIDTH = 2;
const SUSTAIN_HEIGHT = 6;
const SP_COLOR = '#ffd56a';
const SP_GLOW = 'rgba(255, 213, 106, 0.45)';
const PLACEHOLDER_COLOR = 'rgba(245, 240, 227, 0.45)';
const TRACK_BG_TOP = 'rgba(10, 6, 18, 0.85)';
const TRACK_BG_BOTTOM = 'rgba(20, 10, 32, 0.85)';
const LANE_DIVIDER_COLOR = 'rgba(255, 255, 255, 0.08)';

function chartDurationMs(chart: ChartV1): number {
  let max = 0;
  if (chart.sections && chart.sections.length > 0) {
    const last = chart.sections[chart.sections.length - 1]!;
    if (last.endMs > max) max = last.endMs;
  }
  for (const note of chart.notes) {
    const end = note.tMs + (note.durMs ?? 0);
    if (end > max) max = end;
  }
  // Pad slightly so the very last note is not flush against the right edge.
  return Math.max(1000, max + 250);
}

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  message: string,
): void {
  ctx.clearRect(0, 0, width, height);
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, TRACK_BG_TOP);
  grad.addColorStop(1, TRACK_BG_BOTTOM);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = PLACEHOLDER_COLOR;
  ctx.font = "italic 13px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
}

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: TimelineState,
): void {
  ctx.clearRect(0, 0, width, height);
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, TRACK_BG_TOP);
  grad.addColorStop(1, TRACK_BG_BOTTOM);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  const { chart, durationMs } = state;
  if (!chart || durationMs <= 0) {
    drawPlaceholder(ctx, width, height, 'Click Preview to see chart');
    return;
  }

  const innerLeft = TIMELINE_PAD_X;
  const innerRight = width - TIMELINE_PAD_X;
  const innerTop = TIMELINE_PAD_Y;
  const innerBottom = height - TIMELINE_PAD_Y;
  const innerWidth = Math.max(1, innerRight - innerLeft);
  const innerHeight = Math.max(1, innerBottom - innerTop);
  const laneHeight = innerHeight / 2;
  const laneCenterL = innerTop + laneHeight / 2;
  const laneCenterR = innerTop + laneHeight + laneHeight / 2;

  // Lane divider.
  ctx.strokeStyle = LANE_DIVIDER_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(innerLeft, innerTop + laneHeight);
  ctx.lineTo(innerRight, innerTop + laneHeight);
  ctx.stroke();

  const palette = getActivePalette();
  const tickHalfH = (laneHeight - 6) / 2;

  const xFor = (tMs: number): number => {
    const ratio = Math.max(0, Math.min(1, tMs / durationMs));
    return innerLeft + ratio * innerWidth;
  };

  // Pass 1: sustains (so ticks render on top of trails).
  for (const note of chart.notes) {
    const dur = note.durMs ?? 0;
    if (dur <= 0) continue;
    const x0 = xFor(note.tMs);
    const x1 = xFor(note.tMs + dur);
    const cy = note.lane === 'L' ? laneCenterL : laneCenterR;
    const fill = note.lane === 'L' ? palette.L.glow : palette.R.glow;
    ctx.fillStyle = fill;
    ctx.fillRect(x0, cy - SUSTAIN_HEIGHT / 2, Math.max(2, x1 - x0), SUSTAIN_HEIGHT);
  }

  // Pass 2: ticks (regular notes).
  for (const note of chart.notes) {
    const x = xFor(note.tMs);
    const cy = note.lane === 'L' ? laneCenterL : laneCenterR;
    const fill = note.lane === 'L' ? palette.L.fill : palette.R.fill;
    ctx.fillStyle = fill;
    ctx.fillRect(x - TICK_WIDTH / 2, cy - tickHalfH, TICK_WIDTH, tickHalfH * 2);
  }

  // Pass 3: SP markers — small gold star-ish glyph above the tick.
  for (const note of chart.notes) {
    if (note.sp !== true) continue;
    const x = xFor(note.tMs);
    const cy = note.lane === 'L' ? laneCenterL : laneCenterR;
    ctx.fillStyle = SP_GLOW;
    ctx.beginPath();
    ctx.arc(x, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = SP_COLOR;
    ctx.beginPath();
    ctx.arc(x, cy, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Build a re-rendering mini-timeline. Call `render(chart)` whenever a fresh
 * preview chart arrives; the canvas will be redrawn at its current pixel
 * size. Reacts to palette changes (settings.colorBlind) so the tick colours
 * stay in sync without an explicit re-render.
 */
export function createChartTimeline(): ChartTimelineHandle {
  const canvas = document.createElement('canvas');
  canvas.className = 'bh-rechart-preview-canvas';
  // CSS sizes the element; we set the backing-store size on each render so a
  // resize via CSS produces a crisp redraw.
  canvas.style.width = '100%';
  canvas.style.height = `${TIMELINE_HEIGHT}px`;
  canvas.style.display = 'block';

  const root = document.createElement('div');
  root.className = 'bh-rechart-preview-canvas-wrap';
  root.appendChild(canvas);

  const ctx = canvas.getContext('2d');

  const state: TimelineState = { chart: null, durationMs: 0 };

  const paint = (): void => {
    if (!ctx) return;
    const cssWidth = canvas.clientWidth || 600;
    const cssHeight = canvas.clientHeight || TIMELINE_HEIGHT;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const targetW = Math.max(1, Math.round(cssWidth * dpr));
    const targetH = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== targetW) canvas.width = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (state.chart === null) {
      drawPlaceholder(ctx, cssWidth, cssHeight, 'Click Preview to see chart');
    } else {
      drawTimeline(ctx, cssWidth, cssHeight, state);
    }
  };

  const ro =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          paint();
        })
      : null;
  if (ro) ro.observe(canvas);

  const unsubPalette = subscribePalette(() => {
    paint();
  });

  // Initial placeholder paint after the element is laid out. Defer one tick
  // so clientWidth is meaningful when the caller appends the root.
  queueMicrotask(paint);

  return {
    root,
    render(chart: ChartV1 | null, durationMs?: number): void {
      state.chart = chart;
      state.durationMs =
        chart === null
          ? 0
          : typeof durationMs === 'number' && durationMs > 0
            ? durationMs
            : chartDurationMs(chart);
      paint();
    },
    dispose(): void {
      if (ro) ro.disconnect();
      unsubPalette();
    },
  };
}

/**
 * Plain-text summary of a chart for display alongside the timeline. Counts
 * total notes, sustains, and SP-tagged notes.
 */
export function summarizeChart(chart: ChartV1): {
  notes: number;
  sustains: number;
  sp: number;
  bpm: number | undefined;
} {
  let sustains = 0;
  let sp = 0;
  for (const note of chart.notes) {
    if (typeof note.durMs === 'number' && note.durMs > 0) sustains++;
    if (note.sp === true) sp++;
  }
  return { notes: chart.notes.length, sustains, sp, bpm: chart.bpm };
}
