import { describe, expect, it } from 'vitest';

import type { ChartNote, ChartSection } from '@bongos-hero/shared';

import type { FeatureSet, OnsetFeature } from '../audioFeatures.js';
import { buildChart, DEFAULT_TUNABLES } from '../chart.js';

interface MakeFeatureOpts {
  tSec: number;
  rms?: number;
  stereoBalance?: number;
  spectralCentroidHz?: number;
}

function feat({
  tSec,
  rms = 0.5,
  stereoBalance = 0,
  spectralCentroidHz = 1000,
}: MakeFeatureOpts): OnsetFeature {
  return { tSec, rms, stereoBalance, spectralCentroidHz };
}

function set(features: OnsetFeature[]): FeatureSet {
  return {
    sampleRate: 22050,
    durationSec: features.length === 0 ? 0 : features[features.length - 1]!.tSec + 1,
    channelCount: 2,
    features,
  };
}

describe('buildChart', () => {
  it('returns an empty chart for empty input', () => {
    const chart = buildChart({ features: set([]) });
    expect(chart.notes).toEqual([]);
    expect(chart.bpm).toBeUndefined();
    expect(chart.version).toBe(1);
    expect(chart.audioOffsetMs).toBe(0);
  });

  it('drops onsets below the rmsFloor (default 0.005)', () => {
    const chart = buildChart({
      features: set([
        feat({ tSec: 0.1, rms: 0.001 }),
        feat({ tSec: 0.5, rms: 0.5 }),
        feat({ tSec: 1.0, rms: 0.004 }),
      ]),
    });
    expect(chart.notes.map((n) => n.tMs)).toEqual([500]);
  });

  it('respects an overridden rmsFloor', () => {
    const chart = buildChart({
      features: set([feat({ tSec: 0.1, rms: 0.01 }), feat({ tSec: 0.5, rms: 0.5 })]),
      rmsFloor: 0.05,
    });
    expect(chart.notes.map((n) => n.tMs)).toEqual([500]);
  });

  it('dedups same/near-timestamp onsets via the 90 ms forward-pass min-spacing filter', () => {
    const chart = buildChart({
      features: set([
        feat({ tSec: 1.0 }),
        feat({ tSec: 1.0 }),
        feat({ tSec: 1.05 }),
        feat({ tSec: 1.089 }),
        feat({ tSec: 1.09 }),
      ]),
    });
    // Only the first onset at 1.0s and then the next eligible one ≥90 ms later (1.09s) survive.
    expect(chart.notes.map((n) => n.tMs)).toEqual([1000, 1090]);
  });

  it('classifies strongly-negative stereoBalance as L', () => {
    const chart = buildChart({
      features: set([feat({ tSec: 1.0, stereoBalance: -0.8 })]),
    });
    expect(chart.notes[0]?.lane).toBe('L');
  });

  it('classifies strongly-positive stereoBalance as R', () => {
    const chart = buildChart({
      features: set([feat({ tSec: 1.0, stereoBalance: 0.8 })]),
    });
    expect(chart.notes[0]?.lane).toBe('R');
  });

  it('falls back to spectral centroid for near-zero stereo: low → L', () => {
    const chart = buildChart({
      features: set([feat({ tSec: 1.0, stereoBalance: 0.05, spectralCentroidHz: 200 })]),
    });
    expect(chart.notes[0]?.lane).toBe('L');
  });

  it('falls back to spectral centroid for near-zero stereo: high → R', () => {
    const chart = buildChart({
      features: set([feat({ tSec: 1.0, stereoBalance: 0.05, spectralCentroidHz: 5000 })]),
    });
    expect(chart.notes[0]?.lane).toBe('R');
  });

  it('breaks 5 consecutive same-lane onsets by flipping the 5th', () => {
    // 5 strongly-left onsets, well-spaced. The first 4 stay L; the 5th must flip to R.
    // Use 200 ms spacing — comfortably above both 90 ms global and 140 ms same-lane gates.
    const chart = buildChart({
      features: set([
        feat({ tSec: 0.0, stereoBalance: -0.8 }),
        feat({ tSec: 0.2, stereoBalance: -0.8 }),
        feat({ tSec: 0.4, stereoBalance: -0.8 }),
        feat({ tSec: 0.6, stereoBalance: -0.8 }),
        feat({ tSec: 0.8, stereoBalance: -0.8 }),
      ]),
    });
    const lanes = chart.notes.map((n) => n.lane);
    expect(lanes).toEqual(['L', 'L', 'L', 'L', 'R']);
  });

  it('estimates BPM as the clamped median IOI in [60, 200]', () => {
    // 10 onsets, 0.5 s apart → median IOI = 0.5 s → 60/0.5 = 120 bpm.
    const features: OnsetFeature[] = [];
    for (let i = 0; i < 10; i++) {
      features.push(feat({ tSec: 1 + i * 0.5, stereoBalance: i % 2 === 0 ? -0.8 : 0.8 }));
    }
    const chart = buildChart({ features: set(features) });
    expect(chart.bpm).toBe(120);
  });

  it('clamps a slow median IOI to the 60 BPM floor', () => {
    // 10 onsets spaced 1.5 s → 40 bpm raw → clamped to 60.
    const features: OnsetFeature[] = [];
    for (let i = 0; i < 10; i++) {
      features.push(feat({ tSec: 1 + i * 1.5, stereoBalance: i % 2 === 0 ? -0.8 : 0.8 }));
    }
    const chart = buildChart({ features: set(features) });
    expect(chart.bpm).toBe(60);
  });

  it('clamps a fast median IOI to the 200 BPM ceiling', () => {
    // Need IOI < 0.3s to exceed 200 bpm but ≥ 0.14s to survive same-lane filter — use 0.2s
    // (300 bpm raw) with strict L/R alternation so same-lane spacing never triggers.
    const features: OnsetFeature[] = [];
    for (let i = 0; i < 10; i++) {
      features.push(feat({ tSec: 1 + i * 0.2, stereoBalance: i % 2 === 0 ? -0.8 : 0.8 }));
    }
    const chart = buildChart({ features: set(features) });
    expect(chart.bpm).toBe(200);
  });

  it('omits BPM when there are fewer than 8 kept onsets', () => {
    const chart = buildChart({
      features: set([feat({ tSec: 0 }), feat({ tSec: 0.5 }), feat({ tSec: 1.0 })]),
    });
    expect(chart.bpm).toBeUndefined();
  });

  it('tags every 12th note (index 11, 23, …) with sp=true and the rest without', () => {
    const features: OnsetFeature[] = [];
    for (let i = 0; i < 26; i++) {
      // Strict L/R alternation @ 200 ms keeps them all and dodges anti-monotony.
      features.push(feat({ tSec: 1 + i * 0.2, stereoBalance: i % 2 === 0 ? -0.8 : 0.8 }));
    }
    const chart = buildChart({ features: set(features) });
    expect(chart.notes).toHaveLength(26);

    const spIndexes: number[] = [];
    chart.notes.forEach((n, i) => {
      if (n.sp === true) spIndexes.push(i);
    });
    expect(spIndexes).toEqual([11, 23]);

    for (let i = 0; i < chart.notes.length; i++) {
      const note = chart.notes[i]!;
      if (i === 11 || i === 23) {
        expect(note.sp).toBe(true);
      } else {
        expect(note.sp).toBeUndefined();
      }
    }
  });

  it('emits notes sorted ascending by tMs', () => {
    // Feed deliberately out-of-order; the pipeline sorts internally.
    const features: OnsetFeature[] = [
      feat({ tSec: 2.0, stereoBalance: -0.8 }),
      feat({ tSec: 0.5, stereoBalance: 0.8 }),
      feat({ tSec: 1.5, stereoBalance: -0.8 }),
      feat({ tSec: 1.0, stereoBalance: 0.8 }),
    ];
    const chart = buildChart({ features: set(features) });
    const times = chart.notes.map((n) => n.tMs);
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
  });
});

describe('buildChart sections', () => {
  /**
   * Helper: build a `FeatureSet` with onsets every `stepSec` seconds spanning
   * `[0, durationSec)`, where `rmsAt(tSec)` decides each onset's RMS. The
   * onsets alternate L/R via stereoBalance so the lane logic doesn't drop
   * any of them via the same-lane spacing filter.
   */
  function uniformFeatures(
    durationSec: number,
    stepSec: number,
    rmsAt: (tSec: number) => number,
  ): FeatureSet {
    const features: OnsetFeature[] = [];
    let i = 0;
    for (let t = 0; t < durationSec; t += stepSec) {
      features.push(
        feat({
          tSec: t,
          rms: rmsAt(t),
          stereoBalance: i % 2 === 0 ? -0.8 : 0.8,
        }),
      );
      i++;
    }
    return {
      sampleRate: 22050,
      durationSec,
      channelCount: 2,
      features,
    };
  }

  it('returns no sections (undefined) for empty input', () => {
    const chart = buildChart({ features: set([]) });
    expect(chart.sections).toBeUndefined();
  });

  it('emits exactly 1 section spanning the full duration for constant intensity', () => {
    // 60 s of onsets at constant RMS — no transitions to detect.
    const fs = uniformFeatures(60, 0.2, () => 0.5);
    const chart = buildChart({ features: fs });

    expect(chart.sections).toBeDefined();
    const sections = chart.sections!;
    expect(sections).toHaveLength(1);
    expect(sections[0]!.startMs).toBe(0);
    expect(sections[0]!.endMs).toBe(60_000);
    // Constant input → after normalisation everything is 1.0.
    expect(sections[0]!.intensity).toBeCloseTo(1, 5);
  });

  it('emits 2 sections with a boundary near 30 s for a low→high step', () => {
    // 60 s, low (0.05) before 30 s, high (0.5) after.
    const fs = uniformFeatures(60, 0.2, (t) => (t < 30 ? 0.05 : 0.5));
    const chart = buildChart({ features: fs });

    const sections = chart.sections!;
    expect(sections).toHaveLength(2);
    expect(sections[0]!.startMs).toBe(0);
    expect(sections[0]!.endMs).toBe(sections[1]!.startMs);
    // Boundary should land within ±4 s of the true 30 s transition (one
    // window's worth of slack on each side).
    expect(Math.abs(sections[1]!.startMs - 30_000)).toBeLessThanOrEqual(4_000);
    expect(sections[1]!.endMs).toBe(60_000);
    // Intensity rises across the boundary.
    expect(sections[1]!.intensity).toBeGreaterThan(sections[0]!.intensity);
    expect(sections[1]!.intensity - sections[0]!.intensity).toBeGreaterThanOrEqual(0.2);
  });

  it('emits 3 sections for a low→high→low pattern', () => {
    // 60 s, low (0.05) before 20 s, high (0.5) on [20, 40), low (0.05) after.
    const fs = uniformFeatures(60, 0.2, (t) => (t >= 20 && t < 40 ? 0.5 : 0.05));
    const chart = buildChart({ features: fs });

    const sections = chart.sections!;
    expect(sections).toHaveLength(3);
    expect(sections[0]!.startMs).toBe(0);
    expect(sections[2]!.endMs).toBe(60_000);
    // Sections are contiguous.
    expect(sections[0]!.endMs).toBe(sections[1]!.startMs);
    expect(sections[1]!.endMs).toBe(sections[2]!.startMs);
    // Boundaries near 20 s and 40 s within one window's slack.
    expect(Math.abs(sections[1]!.startMs - 20_000)).toBeLessThanOrEqual(4_000);
    expect(Math.abs(sections[2]!.startMs - 40_000)).toBeLessThanOrEqual(4_000);
    // Middle section is the loud one.
    expect(sections[1]!.intensity).toBeGreaterThan(sections[0]!.intensity);
    expect(sections[1]!.intensity).toBeGreaterThan(sections[2]!.intensity);
  });

  it('emits a single full-duration section when the song is shorter than one window', () => {
    // 2 s of audio, well under the 4 s window. Two onsets, one at each end.
    const fs: FeatureSet = {
      sampleRate: 22050,
      durationSec: 2,
      channelCount: 2,
      features: [feat({ tSec: 0.5, rms: 0.4 }), feat({ tSec: 1.5, rms: 0.6 })],
    };
    const chart = buildChart({ features: fs });
    const sections = chart.sections!;
    expect(sections).toHaveLength(1);
    expect(sections[0]!.startMs).toBe(0);
    expect(sections[0]!.endMs).toBe(2000);
    expect(sections[0]!.intensity).toBeGreaterThan(0);
    expect(sections[0]!.intensity).toBeLessThanOrEqual(1);
  });
});

describe('buildChart sustains', () => {
  it('does not mark sustains for two short notes 200 ms apart', () => {
    // Two strongly-L onsets 200 ms apart — way under the 600 ms gap floor,
    // so neither can be a sustain.
    const chart = buildChart({
      features: set([
        feat({ tSec: 0.0, rms: 0.5, stereoBalance: -0.8 }),
        feat({ tSec: 0.2, rms: 0.5, stereoBalance: -0.8 }),
      ]),
    });
    expect(chart.notes).toHaveLength(2);
    for (const n of chart.notes) {
      expect(n.durMs).toBeUndefined();
    }
  });

  it('does not mark a sustain on the very last note (no next-same-lane onset)', () => {
    // A single high-RMS L onset. Even though the audio "would" sustain after
    // it, there's no next note to bound the duration, so durMs must stay
    // undefined.
    const chart = buildChart({
      features: set([feat({ tSec: 0.0, rms: 0.5, stereoBalance: -0.8 })]),
    });
    expect(chart.notes).toHaveLength(1);
    expect(chart.notes[0]!.durMs).toBeUndefined();
  });

  it('marks a sustain (durMs ≈ gap-80) when two same-lane onsets are 1500 ms apart and energy stays high between them', () => {
    // Two L bookend onsets at 0 s and 1.5 s, plus four high-RMS L onsets
    // distributed across the inner window. We crank `minSpacingMs` so only
    // the bookends survive into the chart — the intermediate features are
    // still in the raw `FeatureSet` for the sustain density check to see.
    const features: OnsetFeature[] = [
      feat({ tSec: 0.0, rms: 0.5, stereoBalance: -0.8 }),
      feat({ tSec: 0.3, rms: 0.5, stereoBalance: -0.8 }),
      feat({ tSec: 0.6, rms: 0.5, stereoBalance: -0.8 }),
      feat({ tSec: 0.9, rms: 0.5, stereoBalance: -0.8 }),
      feat({ tSec: 1.2, rms: 0.5, stereoBalance: -0.8 }),
      feat({ tSec: 1.5, rms: 0.5, stereoBalance: -0.8 }),
    ];
    const chart = buildChart({
      features: set(features),
      minSpacingMs: 1500,
      minSameLaneSpacingMs: 1500,
    });
    expect(chart.notes).toHaveLength(2);
    expect(chart.notes[0]!.lane).toBe('L');
    expect(chart.notes[1]!.lane).toBe('L');
    expect(chart.notes[1]!.tMs - chart.notes[0]!.tMs).toBe(1500);

    // gap = 1500, durMs = min(1500-80, 1500) = 1420.
    expect(chart.notes[0]!.durMs).toBe(1420);
    // The last note never gets a durMs.
    expect(chart.notes[1]!.durMs).toBeUndefined();
  });

  it('does not mark a sustain when the inter-onset window is silent (only bookends present)', () => {
    // Same bookends as the previous test, but no intermediate onsets — i.e.
    // silence between the two notes. The density check excludes the first
    // 100 ms of the window and finds zero high-RMS features, so no sustain.
    const chart = buildChart({
      features: set([
        feat({ tSec: 0.0, rms: 0.5, stereoBalance: -0.8 }),
        feat({ tSec: 1.5, rms: 0.5, stereoBalance: -0.8 }),
      ]),
      minSpacingMs: 1500,
      minSameLaneSpacingMs: 1500,
    });
    expect(chart.notes).toHaveLength(2);
    for (const n of chart.notes) {
      expect(n.durMs).toBeUndefined();
    }
  });
});

/**
 * Behavioral coverage for the `tunables` second arg added by the re-chart
 * surface. Each test exercises one knob and verifies it dominates over the
 * `BuildChartOptions` defaults / DEFAULT_TUNABLES.
 */
describe('buildChart tunables', () => {
  function dense(count: number, stepSec = 0.05): OnsetFeature[] {
    // `stepSec = 50ms` is below the 90 ms default min-spacing, so the
    // baseline run dedupes ~half the onsets — perfect for showing
    // `minSpacingMs` overrides change the kept count meaningfully.
    const features: OnsetFeature[] = [];
    for (let i = 0; i < count; i++) {
      features.push(
        feat({
          tSec: 0.1 + i * stepSec,
          rms: 0.05 + (i % 5) * 0.02,
          stereoBalance: i % 2 === 0 ? -0.7 : 0.7,
          spectralCentroidHz: i % 3 === 0 ? 800 : 2400,
        }),
      );
    }
    return features;
  }

  it('exposes DEFAULT_TUNABLES matching the legacy in-function literals', () => {
    expect(DEFAULT_TUNABLES).toEqual({
      rmsFloor: 0.005,
      minSpacingMs: 90,
      centroidThreshold: 1500,
      snapDivisions: 4,
      snapToleranceMs: 35,
      chorusIntensityThreshold: 0.65,
      verseIntensityThreshold: 0.3,
      verseKeepRatio: 0.7,
    });
  });

  it('drops most onsets when rmsFloor is raised aggressively (0.5)', () => {
    // Mix loud (rms > 0.5) and quiet (rms < 0.05) onsets. With the 0.005
    // default everything survives the floor; with 0.5 only the loud ones do.
    const features: OnsetFeature[] = [
      feat({ tSec: 0.0, rms: 0.6, stereoBalance: -0.8 }),
      feat({ tSec: 0.3, rms: 0.02, stereoBalance: 0.8 }),
      feat({ tSec: 0.6, rms: 0.7, stereoBalance: -0.8 }),
      feat({ tSec: 0.9, rms: 0.03, stereoBalance: 0.8 }),
      feat({ tSec: 1.2, rms: 0.55, stereoBalance: -0.8 }),
      feat({ tSec: 1.5, rms: 0.01, stereoBalance: 0.8 }),
    ];
    const baseline = buildChart({ features: set(features) });
    const tuned = buildChart({ features: set(features) }, { rmsFloor: 0.5 });
    expect(baseline.notes.length).toBeGreaterThan(tuned.notes.length);
    expect(tuned.notes.map((n) => n.tMs)).toEqual([0, 600, 1200]);
  });

  it('aggressively dedupes when minSpacingMs is raised to 500', () => {
    const features = dense(20);
    const baseline = buildChart({ features: set(features) });
    const tuned = buildChart({ features: set(features) }, { minSpacingMs: 500 });
    // Baseline keeps roughly every other onset (50 ms step → 90 ms gate keeps ~half).
    expect(baseline.notes.length).toBeGreaterThanOrEqual(8);
    // 500 ms gate against a 50 ms step → at most ~⌈(0.1 + 19*0.05) / 0.5⌉ + 1 ≈ 3 kept.
    expect(tuned.notes.length).toBeLessThanOrEqual(3);
    // Spacing invariant: every kept-pair gap ≥ minSpacingMs.
    for (let i = 1; i < tuned.notes.length; i++) {
      expect(tuned.notes[i]!.tMs - tuned.notes[i - 1]!.tMs).toBeGreaterThanOrEqual(500);
    }
  });

  it('reroutes lane classification when centroidThreshold is shifted high', () => {
    // Stereo-neutral onsets so classification falls through to the centroid
    // branch. With threshold 1500, the 2400 Hz onset → R; with threshold
    // 3000, it → L.
    const features: OnsetFeature[] = [
      feat({ tSec: 1.0, rms: 0.3, stereoBalance: 0.05, spectralCentroidHz: 2400 }),
    ];
    expect(buildChart({ features: set(features) }).notes[0]!.lane).toBe('R');
    expect(
      buildChart({ features: set(features) }, { centroidThreshold: 3000 }).notes[0]!.lane,
    ).toBe('L');
  });

  it('default invocation is byte-identical to passing DEFAULT_TUNABLES explicitly (regression guard)', () => {
    // Build a deterministic, mid-density FeatureSet that exercises rmsFloor,
    // min-spacing, lane classification (both stereo + centroid branches),
    // anti-monotony fixup, BPM estimation, sp tagging, sustains, and
    // sections — i.e. every code path touched by the tunables — then assert
    // the no-tunables and DEFAULT_TUNABLES outputs deep-equal.
    const features: OnsetFeature[] = [];
    for (let i = 0; i < 30; i++) {
      features.push(
        feat({
          tSec: 0.1 + i * 0.18,
          rms: 0.05 + (i % 5) * 0.02,
          stereoBalance: i % 2 === 0 ? -0.7 : 0.7,
          spectralCentroidHz: i % 3 === 0 ? 800 : 2400,
        }),
      );
    }
    const fs: FeatureSet = {
      sampleRate: 22050,
      durationSec: 8,
      channelCount: 2,
      features,
    };
    const legacy = buildChart({ features: fs });
    const explicit = buildChart({ features: fs }, { ...DEFAULT_TUNABLES });
    expect(explicit).toEqual(legacy);
    // Sanity: the snapshot must contain real notes, otherwise an empty
    // chart would trivially equal an empty chart and hide regressions.
    expect(legacy.notes.length).toBeGreaterThan(5);
  });

  it('tunables values dominate over BuildChartOptions same-key values', () => {
    const features: OnsetFeature[] = [
      feat({ tSec: 0.0, rms: 0.3, stereoBalance: -0.8 }),
      feat({ tSec: 0.3, rms: 0.02, stereoBalance: 0.8 }),
      feat({ tSec: 0.6, rms: 0.4, stereoBalance: -0.8 }),
    ];
    // opts asks for rmsFloor 0.005 (would keep all three), tunables asks
    // for 0.1 (drops the 0.02 onset). Tunables must win.
    const chart = buildChart({ features: set(features), rmsFloor: 0.005 }, { rmsFloor: 0.1 });
    expect(chart.notes.map((n) => n.tMs)).toEqual([0, 600]);
  });
});

/**
 * Behavioral coverage for the beat-grid snap pass (step 7b in `buildChart`).
 *
 * Each test builds a feature set with ≥8 strictly-alternating L/R onsets so
 * BPM is detected, then asserts how a deliberately off-grid note survives or
 * gets pulled to the nearest grid line.
 */
describe('buildChart beat-grid snap', () => {
  /**
   * Build N strictly L/R-alternating onsets at `times` (seconds). Padded with
   * extra onsets at `padStart + i*0.5` (so median IOI = 0.5 s → BPM 120) until
   * we have at least 8 entries — enough for BPM detection to engage.
   */
  function bpm120Features(targetTimesSec: number[], padStart = 10): OnsetFeature[] {
    const features: OnsetFeature[] = [];
    let i = 0;
    for (const t of targetTimesSec) {
      features.push(feat({ tSec: t, stereoBalance: i % 2 === 0 ? -0.8 : 0.8 }));
      i++;
    }
    while (features.length < 10) {
      features.push(
        feat({
          tSec: padStart + (features.length - targetTimesSec.length) * 0.5,
          stereoBalance: features.length % 2 === 0 ? -0.8 : 0.8,
        }),
      );
    }
    return features;
  }

  it('snaps onsets within tolerance to the nearest 16th-note grid line', () => {
    // BPM 120 → beatMs = 500, cellMs = 500/4 = 125. The 16th-note grid lines
    // around 500 ms are at 375 / 500 / 625. Onsets at 502 ms (2 ms off) and
    // 504 ms (4 ms off) both snap to 500 ms.
    const featuresA = bpm120Features([0.0, 0.502, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5]);
    const chartA = buildChart({ features: set(featuresA) });
    expect(chartA.bpm).toBe(120);
    expect(chartA.notes[1]!.tMs).toBe(500);

    const featuresB = bpm120Features([0.0, 0.504, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5]);
    const chartB = buildChart({ features: set(featuresB) });
    expect(chartB.bpm).toBe(120);
    expect(chartB.notes[1]!.tMs).toBe(500);
  });

  it('leaves onsets outside the tolerance untouched', () => {
    // BPM 120, cellMs = 125. An onset at 540 ms is 40 ms off the nearest cell
    // (500 ms) — beyond the 35 ms default tolerance — so it stays at 540 ms.
    const features = bpm120Features([0.0, 0.54, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5]);
    const chart = buildChart({ features: set(features) });
    expect(chart.bpm).toBe(120);
    expect(chart.notes[1]!.tMs).toBe(540);
  });

  it('is a no-op when bpm is undefined (fewer than 8 kept onsets)', () => {
    // Three onsets → bpm not estimated → snap pass must not engage. The
    // off-grid 502 ms onset must survive unchanged.
    const chart = buildChart({
      features: set([
        feat({ tSec: 0.0, stereoBalance: -0.8 }),
        feat({ tSec: 0.502, stereoBalance: 0.8 }),
        feat({ tSec: 1.0, stereoBalance: -0.8 }),
      ]),
    });
    expect(chart.bpm).toBeUndefined();
    expect(chart.notes.map((n) => n.tMs)).toEqual([0, 502, 1000]);
  });

  it('disables snap entirely when snapDivisions is 0', () => {
    // Same off-grid 502 ms onset as the 16th-note test, but with snap turned
    // off via tunables.snapDivisions = 0 — the onset stays at 502 ms.
    const features = bpm120Features([0.0, 0.502, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5]);
    const chart = buildChart({ features: set(features) }, { snapDivisions: 0 });
    expect(chart.bpm).toBe(120);
    expect(chart.notes[1]!.tMs).toBe(502);
  });

  it('snaps to the quarter-note grid when snapDivisions is 1', () => {
    // BPM 120 → beatMs = 500, cellMs = 500/1 = 500. An onset at 498 ms is 2 ms
    // off the nearest quarter-grid cell (500 ms) → snaps to 500 ms.
    const features = bpm120Features([0.0, 0.498, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5]);
    const chart = buildChart({ features: set(features) }, { snapDivisions: 1 });
    expect(chart.bpm).toBe(120);
    expect(chart.notes[1]!.tMs).toBe(500);
  });

  it('exposes snapDivisions=4 and snapToleranceMs=35 as the default tunables', () => {
    // Regression guard for the documented defaults — anything that quietly
    // changes them would silently rewrite every imported chart.
    expect(DEFAULT_TUNABLES.snapDivisions).toBe(4);
    expect(DEFAULT_TUNABLES.snapToleranceMs).toBe(35);
  });
});

/**
 * Behavioral coverage for the per-section difficulty thinning pass. Each test
 * builds a 60 s chart with a clear high-RMS chorus followed by a low-RMS
 * intro/outro-like section, then asserts how the per-section pass interacts
 * with `BuildChartOptions.difficulty` and the new `verseKeepRatio` knob.
 */
describe('buildChart per-section difficulty', () => {
  /**
   * Helper: 60 s song with high RMS for the first 30 s (chorus-like) and a
   * very low RMS (just above `rmsFloor` 0.005, below the sustain detector's
   * 0.0075 high-RMS threshold) for the second 30 s. Onsets every 0.5 s with
   * strict L/R alternation, so all 120 onsets survive lane + min-spacing
   * filtering and BPM lands cleanly on 120.
   */
  function highLowFeatures(): FeatureSet {
    const features: OnsetFeature[] = [];
    let i = 0;
    for (let t = 0; t < 60; t += 0.5) {
      const rms = t < 30 ? 0.5 : 0.006;
      features.push(
        feat({
          tSec: t,
          rms,
          stereoBalance: i % 2 === 0 ? -0.8 : 0.8,
        }),
      );
      i++;
    }
    return { sampleRate: 22050, durationSec: 60, channelCount: 2, features };
  }

  /**
   * Like `highLowFeatures` but injects a single high-RMS "ghost" feature
   * 50 ms after the 30.5 s low onset. The default 90 ms min-spacing filter
   * drops the ghost from the chart, but the sustain detector still sees it
   * inside the inner-window of the L note at tMs=30000 — marking that one
   * low-section note as a sustain so we can exercise sustain protection.
   */
  function highLowWithSustainFeatures(): FeatureSet {
    const fs = highLowFeatures();
    const features = [...fs.features, feat({ tSec: 30.55, rms: 0.5, stereoBalance: 0.8 })];
    features.sort((a, b) => a.tSec - b.tSec);
    return { ...fs, features };
  }

  function notesIn(notes: readonly ChartNote[], section: ChartSection): ChartNote[] {
    return notes.filter((n) => n.tMs >= section.startMs && n.tMs < section.endMs);
  }

  it('thins notes only in low-intensity sections, leaving choruses untouched', () => {
    const fs = highLowFeatures();
    const baseline = buildChart({ features: fs, difficulty: 'hard' });
    const easy = buildChart({ features: fs, difficulty: 'easy' });

    const sections = baseline.sections!;
    expect(sections.length).toBeGreaterThanOrEqual(2);
    const high = sections[0]!;
    const low = sections[sections.length - 1]!;
    expect(high.intensity).toBeGreaterThan(0.65);
    expect(low.intensity).toBeLessThanOrEqual(0.3);

    // Chorus section: same count as the unthinned baseline.
    expect(notesIn(easy.notes, high).length).toBe(notesIn(baseline.notes, high).length);

    // Low section: kept ratio sits near verseKeepRatio 0.7 (drop every 3rd
    // droppable ⇒ ~67%). Allow ±0.15 slack to absorb the SP/sustain
    // protection adjustment and section-boundary placement.
    const baseLow = notesIn(baseline.notes, low).length;
    const easyLow = notesIn(easy.notes, low).length;
    expect(baseLow).toBeGreaterThan(0);
    const ratio = easyLow / baseLow;
    expect(ratio).toBeGreaterThanOrEqual(0.55);
    expect(ratio).toBeLessThanOrEqual(0.85);
  });

  it('keeps every note when verseKeepRatio is 1.0 (per-section thinning disabled)', () => {
    const fs = highLowFeatures();
    const baseline = buildChart({ features: fs, difficulty: 'hard' });
    const easyDisabled = buildChart({ features: fs, difficulty: 'easy', verseKeepRatio: 1.0 });
    expect(easyDisabled.notes.length).toBe(baseline.notes.length);
    for (let i = 0; i < baseline.notes.length; i++) {
      expect(easyDisabled.notes[i]!.tMs).toBe(baseline.notes[i]!.tMs);
    }
  });

  it('preserves SP-tagged notes in low-intensity sections under aggressive thinning', () => {
    const fs = highLowFeatures();
    const baseline = buildChart({ features: fs, difficulty: 'hard' });
    // verseKeepRatio 0.1 collapses to "drop every other droppable" (clamped
    // to N=2) — the strongest low-section thinning the function will apply.
    const aggressive = buildChart({ features: fs, difficulty: 'easy', verseKeepRatio: 0.1 });

    const sections = baseline.sections!;
    const low = sections[sections.length - 1]!;
    const baseSp = notesIn(baseline.notes, low).filter((n) => n.sp === true);
    const aggSp = notesIn(aggressive.notes, low).filter((n) => n.sp === true);

    expect(baseSp.length).toBeGreaterThan(0);
    expect(aggSp.length).toBe(baseSp.length);
    expect(aggSp.map((n) => n.tMs)).toEqual(baseSp.map((n) => n.tMs));

    // Sanity: non-SP notes in the same low section were thinned dramatically.
    const baseNonSp = notesIn(baseline.notes, low).filter((n) => n.sp !== true);
    const aggNonSp = notesIn(aggressive.notes, low).filter((n) => n.sp !== true);
    expect(aggNonSp.length).toBeLessThan(baseNonSp.length);
  });

  it('preserves sustain-tagged notes in low-intensity sections under aggressive thinning', () => {
    const fs = highLowWithSustainFeatures();
    const baseline = buildChart({ features: fs, difficulty: 'hard' });
    const aggressive = buildChart({ features: fs, difficulty: 'easy', verseKeepRatio: 0.1 });

    const sections = baseline.sections!;
    const low = sections[sections.length - 1]!;
    const baseSustains = notesIn(baseline.notes, low).filter(
      (n) => n.durMs !== undefined && n.durMs > 0,
    );
    const aggSustains = notesIn(aggressive.notes, low).filter(
      (n) => n.durMs !== undefined && n.durMs > 0,
    );

    expect(baseSustains.length).toBeGreaterThan(0);
    expect(aggSustains.length).toBe(baseSustains.length);
    expect(aggSustains.map((n) => n.tMs)).toEqual(baseSustains.map((n) => n.tMs));
  });

  it("difficulty: 'hard' skips per-section thinning entirely (low section keeps 100%)", () => {
    const fs = highLowFeatures();
    const noDifficulty = buildChart({ features: fs });
    const hard = buildChart({ features: fs, difficulty: 'hard' });

    expect(hard.notes.length).toBe(noDifficulty.notes.length);
    for (let i = 0; i < hard.notes.length; i++) {
      expect(hard.notes[i]!.tMs).toBe(noDifficulty.notes[i]!.tMs);
    }
    // And the low-section count matches the unthinned baseline exactly.
    const sections = hard.sections!;
    const low = sections[sections.length - 1]!;
    expect(notesIn(hard.notes, low).length).toBe(notesIn(noDifficulty.notes, low).length);
  });

  it('exposes the per-section thresholds and verseKeepRatio via DEFAULT_TUNABLES', () => {
    // Regression guard for the documented defaults so `verseKeepRatio: 1.0`
    // remains a reliable "off switch" and the chorus/verse breakpoints stay
    // in lockstep with the spec.
    expect(DEFAULT_TUNABLES.chorusIntensityThreshold).toBe(0.65);
    expect(DEFAULT_TUNABLES.verseIntensityThreshold).toBe(0.3);
    expect(DEFAULT_TUNABLES.verseKeepRatio).toBe(0.7);
  });
});
