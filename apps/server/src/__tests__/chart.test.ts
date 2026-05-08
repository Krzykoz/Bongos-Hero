import { describe, expect, it } from 'vitest';

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
