import type { ChartNote, ChartSection, ChartV1, Lane } from '@bongos-hero/shared';

import type { FeatureSet, OnsetFeature } from './audioFeatures.js';

// ---- Sustain detection ------------------------------------------------------
//
// Heuristic: a note becomes a "sustain" (player must hold its lane key through
// `durMs`) when (a) the gap to the NEXT same-lane onset is meaningfully long,
// and (b) the audio is energetically active during that window — i.e. the song
// is in a held chord / sustained-vocal / pad-style passage rather than an
// empty rest.
//
// We approximate (b) using the per-onset RMS samples already in the
// `FeatureSet`: high-RMS onsets distributed inside the window indicate
// ongoing activity, while a window with only the two bookend onsets (the note
// itself + the next-same-lane note) and silence between them indicates a rest.
//
// To avoid false positives where the note's own onset RMS is enough to satisfy
// the density check on its own, we EXCLUDE the first `SUSTAIN_INTRO_OFFSET_MS`
// of the window from the density count.

/** Minimum same-lane gap (ms) required for a note to even be considered for sustain. */
const SUSTAIN_MIN_GAP_MS = 600;
/** Hard cap on a sustain's `durMs` — long enough to feel like a hold, short enough to fit on screen. */
const SUSTAIN_WINDOW_CAP_MS = 1500;
/** Subtracted from `gap` when computing `durMs` so the trail never overlaps the next onset. */
const SUSTAIN_SAFETY_MS = 80;
/** Skip this much of the window's start so the note's own onset RMS doesn't dominate. */
const SUSTAIN_INTRO_OFFSET_MS = 100;
/** Multiplier applied to `rmsFloor` to define "energetic enough to count as sustained". */
const SUSTAIN_RMS_MULTIPLIER = 1.5;
/** One high-RMS onset is required per this many ms of effective window. */
const SUSTAIN_DENSITY_PERIOD_MS = 500;

/**
 * In-place pass that adds `durMs` to any `ChartNote` that the audio supports
 * being held through. Operates on the post-classification, post-spacing notes
 * so the same-lane lookup is meaningful, and reads from the *raw* per-onset
 * RMS samples so we still see in-window activity that was filtered out for
 * being too dense to chart.
 *
 * `features` does not have to be sorted by `tSec` — we filter on a per-feature
 * basis rather than relying on early-break.
 */
function detectSustains(
  notes: ChartNote[],
  features: readonly OnsetFeature[],
  rmsFloor: number,
): void {
  if (notes.length < 2) return;
  const highThreshold = rmsFloor * SUSTAIN_RMS_MULTIPLIER;

  for (let i = 0; i < notes.length - 1; i++) {
    const note = notes[i]!;

    // Find the next same-lane note, if any.
    let nextSameLaneIdx = -1;
    for (let j = i + 1; j < notes.length; j++) {
      if (notes[j]!.lane === note.lane) {
        nextSameLaneIdx = j;
        break;
      }
    }
    if (nextSameLaneIdx === -1) continue;

    const gap = notes[nextSameLaneIdx]!.tMs - note.tMs;
    if (gap <= SUSTAIN_MIN_GAP_MS) continue;

    const windowMs = Math.min(gap, SUSTAIN_WINDOW_CAP_MS);
    const innerStartMs = note.tMs + SUSTAIN_INTRO_OFFSET_MS;
    const innerEndMs = note.tMs + windowMs;
    const innerWindowMs = innerEndMs - innerStartMs;
    if (innerWindowMs <= 0) continue;

    let highCount = 0;
    for (const f of features) {
      const tMs = f.tSec * 1000;
      if (tMs < innerStartMs || tMs >= innerEndMs) continue;
      if (f.rms >= highThreshold) highCount++;
    }

    const required = Math.max(1, Math.floor(innerWindowMs / SUSTAIN_DENSITY_PERIOD_MS));
    if (highCount < required) continue;

    note.durMs = Math.min(gap - SUSTAIN_SAFETY_MS, SUSTAIN_WINDOW_CAP_MS);
  }
}

// ---- Section detection ------------------------------------------------------

/** Length of the analysis window for section RMS, in milliseconds. */
const SECTION_WINDOW_MS = 4000;
/** Hop between adjacent windows, in milliseconds. */
const SECTION_HOP_MS = 2000;
/** Half-width of the moving-average smoother over normalised RMS, in windows. */
const SECTION_SMOOTH_HALF = 1;
/** A boundary fires when smoothed intensity changes by ≥ this between windows. */
const SECTION_BOUNDARY_THRESHOLD = 0.2;
/**
 * Minimum gap between two consecutive boundary fires, in windows. A
 * smooth ramp from low to high will cross the threshold over several
 * adjacent windows; we only want the first crossing to register so a
 * single transition does not become two boundaries.
 */
const SECTION_BOUNDARY_REFRACTORY = 2;

export interface BuildChartOptions {
  features: FeatureSet;
  /** Minimum spacing between any two notes regardless of lane (ms). Default 90. */
  minSpacingMs?: number;
  /** Minimum spacing between notes in the same lane (ms). Default 140. */
  minSameLaneSpacingMs?: number;
  /** Stereo-balance magnitude threshold above which we trust stereo classification. Default 0.12. */
  stereoConfidenceThreshold?: number;
  /** Spectral-centroid Hz threshold separating low (L) from high (R). Default 1500. */
  centroidSplitHz?: number;
  /** RMS floor — onsets below this are dropped (likely silence/ghosts). Default 0.005. */
  rmsFloor?: number;
  /** Mark every Nth note as Star Power. Default 12. */
  spEveryN?: number;
}

/**
 * Chart pipeline knobs exposed through the re-chart API. A subset of
 * `BuildChartOptions` keyed by stable, UI-facing names — the web scene's
 * sliders and the `POST /api/rechart` body type both reference this shape.
 *
 * `centroidThreshold` is the public name for the same Hz cutoff the legacy
 * `BuildChartOptions.centroidSplitHz` exposes, so callers picking either
 * surface get the same behavior.
 */
export interface ChartTunables {
  /** RMS floor — onsets below this are dropped (likely silence/ghosts). */
  rmsFloor?: number;
  /** Minimum spacing between any two notes regardless of lane (ms). */
  minSpacingMs?: number;
  /** Spectral-centroid Hz threshold separating low (L) from high (R). */
  centroidThreshold?: number;
}

/**
 * Pipeline defaults, mirrored from the in-function `?? <literal>` fall-throughs
 * in `buildChart`. Exported so the re-chart route + web sliders can show the
 * same baseline the auto-import job uses.
 *
 * If you change any of these, update the literals in `buildChart` to match.
 */
export const DEFAULT_TUNABLES: Required<ChartTunables> = {
  rmsFloor: 0.005,
  minSpacingMs: 90,
  centroidThreshold: 1500,
};

function classifyLane(
  feature: OnsetFeature,
  stereoConfidenceThreshold: number,
  centroidSplitHz: number,
): Lane {
  if (Math.abs(feature.stereoBalance) >= stereoConfidenceThreshold) {
    return feature.stereoBalance > 0 ? 'R' : 'L';
  }
  return feature.spectralCentroidHz >= centroidSplitHz ? 'R' : 'L';
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if ((sorted.length & 1) === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function flip(lane: Lane): Lane {
  return lane === 'L' ? 'R' : 'L';
}

/**
 * Aggregate per-onset RMS into fixed-size windows over the full song,
 * normalise, smooth, and emit boundary-to-boundary `ChartSection`s.
 *
 * Returns `undefined` when there is no audio analysis to draw from. Returns a
 * single section spanning the full duration when the song is shorter than one
 * window or has no detectable variation.
 */
function detectSections(
  features: readonly OnsetFeature[],
  durationSec: number,
): ChartSection[] | undefined {
  if (features.length === 0) return undefined;

  const durationMs = Math.max(0, Math.round(durationSec * 1000));
  if (durationMs <= 0) return undefined;

  // Too short for windowed analysis: emit one section spanning the whole song.
  if (durationMs < SECTION_WINDOW_MS) {
    let sum = 0;
    for (const f of features) sum += f.rms;
    const mean = sum / features.length;
    return [{ startMs: 0, endMs: durationMs, intensity: clamp01(mean) }];
  }

  // 1. Per-window mean RMS over the onset features.
  const windowCount = Math.floor((durationMs - SECTION_WINDOW_MS) / SECTION_HOP_MS) + 1;
  const raw = new Array<number>(windowCount).fill(0);
  for (let w = 0; w < windowCount; w++) {
    const startMs = w * SECTION_HOP_MS;
    const endMs = startMs + SECTION_WINDOW_MS;
    let sum = 0;
    let count = 0;
    for (const f of features) {
      const tMs = f.tSec * 1000;
      if (tMs >= startMs && tMs < endMs) {
        sum += f.rms;
        count++;
      }
    }
    raw[w] = count > 0 ? sum / count : 0;
  }

  // 2. Normalise to 0..1 across the song.
  let maxR = 0;
  for (const v of raw) {
    if (v > maxR) maxR = v;
  }
  const normalized: number[] = new Array<number>(windowCount);
  for (let i = 0; i < windowCount; i++) {
    normalized[i] = maxR > 0 ? raw[i]! / maxR : 0;
  }

  // 3. 3-window moving-average smoother (1 window of half-width either side).
  const smoothed: number[] = new Array<number>(windowCount);
  for (let i = 0; i < windowCount; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = -SECTION_SMOOTH_HALF; j <= SECTION_SMOOTH_HALF; j++) {
      const k = i + j;
      if (k >= 0 && k < windowCount) {
        sum += normalized[k]!;
        cnt++;
      }
    }
    smoothed[i] = cnt > 0 ? sum / cnt : 0;
  }

  // 4. Boundary detection: |Δsmoothed| ≥ threshold, with a refractory gap so
  //    one ramp counts as one boundary.
  const boundaries: number[] = [0];
  let lastBoundary = -SECTION_BOUNDARY_REFRACTORY;
  for (let i = 1; i < windowCount; i++) {
    const delta = Math.abs(smoothed[i]! - smoothed[i - 1]!);
    if (delta >= SECTION_BOUNDARY_THRESHOLD && i - lastBoundary >= SECTION_BOUNDARY_REFRACTORY) {
      boundaries.push(i);
      lastBoundary = i;
    }
  }

  // 5. Build sections from boundary spans, with mean smoothed intensity.
  const sections: ChartSection[] = [];
  for (let b = 0; b < boundaries.length; b++) {
    const startIdx = boundaries[b]!;
    const endIdx = b + 1 < boundaries.length ? boundaries[b + 1]! : windowCount;
    let sum = 0;
    for (let i = startIdx; i < endIdx; i++) sum += smoothed[i]!;
    const span = endIdx - startIdx;
    const mean = span > 0 ? sum / span : 0;
    const startMs = startIdx * SECTION_HOP_MS;
    const endMs = b + 1 < boundaries.length ? boundaries[b + 1]! * SECTION_HOP_MS : durationMs;
    sections.push({ startMs, endMs, intensity: clamp01(mean) });
  }
  return sections;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Build a `ChartV1` from extracted onset features.
 *
 * `tunables` is the optional re-chart override surface: when provided, its
 * keys take precedence over `opts`'s legacy `rmsFloor` / `minSpacingMs` /
 * `centroidSplitHz` and over `DEFAULT_TUNABLES`. Pass `undefined` (the only
 * shape any pre-existing call site uses) for byte-identical legacy behavior.
 */
export function buildChart(opts: BuildChartOptions, tunables?: ChartTunables): ChartV1 {
  const tuned = tunables ? { ...DEFAULT_TUNABLES, ...tunables } : null;
  const minSpacingMs = tuned?.minSpacingMs ?? opts.minSpacingMs ?? DEFAULT_TUNABLES.minSpacingMs;
  const minSameLaneSpacingMs = opts.minSameLaneSpacingMs ?? 140;
  const stereoConfidenceThreshold = opts.stereoConfidenceThreshold ?? 0.12;
  const centroidSplitHz =
    tuned?.centroidThreshold ?? opts.centroidSplitHz ?? DEFAULT_TUNABLES.centroidThreshold;
  const rmsFloor = tuned?.rmsFloor ?? opts.rmsFloor ?? DEFAULT_TUNABLES.rmsFloor;
  const spEveryN = opts.spEveryN ?? 12;

  // 1. Drop low-RMS onsets.
  const loud: OnsetFeature[] = opts.features.features.filter((f) => f.rms >= rmsFloor);

  // Make sure they are sorted ascending in time.
  loud.sort((a, b) => a.tSec - b.tSec);

  // 2. Apply min-spacing in a single forward pass (keep-first).
  const minSpacingSec = minSpacingMs / 1000;
  const kept: OnsetFeature[] = [];
  let lastKeptSec = -Infinity;
  for (const f of loud) {
    if (f.tSec - lastKeptSec >= minSpacingSec) {
      kept.push(f);
      lastKeptSec = f.tSec;
    }
  }

  // 3. Classify each kept onset's lane.
  const lanes: Lane[] = kept.map((f) =>
    classifyLane(f, stereoConfidenceThreshold, centroidSplitHz),
  );

  // 4. Anti-monotony fixup: if same lane chosen 4+ times in a row, flip the next one.
  let runLane: Lane | null = null;
  let runLen = 0;
  for (let i = 0; i < lanes.length; i++) {
    const current = lanes[i]!;
    if (runLane !== null && current === runLane && runLen >= 4) {
      // Flip this note to break the run.
      const flipped = flip(current);
      lanes[i] = flipped;
      runLane = flipped;
      runLen = 1;
    } else if (current === runLane) {
      runLen++;
    } else {
      runLane = current;
      runLen = 1;
    }
  }

  // 5. Same-lane min-spacing: if two consecutive same-lane notes are within
  //    minSameLaneSpacingMs, flip the second to the other lane.
  const minSameLaneSec = minSameLaneSpacingMs / 1000;
  for (let i = 1; i < kept.length; i++) {
    if (lanes[i] === lanes[i - 1]) {
      const dt = kept[i]!.tSec - kept[i - 1]!.tSec;
      if (dt < minSameLaneSec) {
        lanes[i] = flip(lanes[i]!);
      }
    }
  }

  // 6. Tempo estimate from median inter-onset interval.
  let bpm: number | undefined;
  if (kept.length >= 8) {
    const iois: number[] = [];
    for (let i = 1; i < kept.length; i++) {
      iois.push(kept[i]!.tSec - kept[i - 1]!.tSec);
    }
    const medianIoi = median(iois);
    if (medianIoi > 0) {
      const raw = Math.round(60 / medianIoi);
      bpm = Math.max(60, Math.min(200, raw));
    }
  }

  // 7. Build notes; tag every Nth as Star Power.
  const notes: ChartNote[] = kept.map((f, i) => {
    const lane = lanes[i]!;
    const note: ChartNote = {
      tMs: Math.round(f.tSec * 1000),
      lane,
    };
    if (spEveryN > 0 && (i + 1) % spEveryN === 0) {
      note.sp = true;
    }
    return note;
  });

  // 8. Final sort by tMs (already sorted, but be defensive).
  notes.sort((a, b) => a.tMs - b.tMs);

  // 9. Sustain detection — runs after the final sort so the same-lane "next
  //    onset" lookup walks the same ordering downstream consumers see.
  detectSustains(notes, opts.features.features, rmsFloor);

  const chart: ChartV1 = {
    version: 1,
    audioOffsetMs: 0,
    notes,
  };
  if (bpm !== undefined) chart.bpm = bpm;

  // 10. Section detection over the full feature set (pre-min-spacing) so a
  //     quiet but onset-dense bridge is not misclassified as low intensity.
  const sections = detectSections(opts.features.features, opts.features.durationSec);
  if (sections !== undefined) chart.sections = sections;

  return chart;
}
