import type { ChartNote, ChartV1, Lane } from '@bongos-hero/shared';

import type { FeatureSet, OnsetFeature } from './audioFeatures.js';

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
  return ((sorted[mid - 1]! as number) + (sorted[mid]! as number)) / 2;
}

function flip(lane: Lane): Lane {
  return lane === 'L' ? 'R' : 'L';
}

export function buildChart(opts: BuildChartOptions): ChartV1 {
  const minSpacingMs = opts.minSpacingMs ?? 90;
  const minSameLaneSpacingMs = opts.minSameLaneSpacingMs ?? 140;
  const stereoConfidenceThreshold = opts.stereoConfidenceThreshold ?? 0.12;
  const centroidSplitHz = opts.centroidSplitHz ?? 1500;
  const rmsFloor = opts.rmsFloor ?? 0.005;
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
      const dt = (kept[i]!.tSec) - (kept[i - 1]!.tSec);
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

  const chart: ChartV1 = {
    version: 1,
    audioOffsetMs: 0,
    notes,
  };
  if (bpm !== undefined) chart.bpm = bpm;
  return chart;
}
