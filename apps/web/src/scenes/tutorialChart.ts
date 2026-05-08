/**
 * Built-in tutorial chart.
 *
 * Hand-authored 12-note `ChartV1` that fits inside the ~30-second tutorial
 * window driven by `apps/web/src/scenes/tutorial.ts`. The notes are timed
 * against an internal `performance.now()` clock — there is no audio source,
 * so `audioOffsetMs` is 0 and `bpm` (100, half-second beats) is used only by
 * `BackgroundRenderer` to set the band/crowd pulse.
 *
 * Layout of the chart by section:
 *   - 3.0–5.8 s: 5 simple alternating L/R notes (lane intro)
 *   - 14.5 / 17.5 s: two 1.5-second sustains (hold-the-key intro)
 *   - 23.0–28.5 s: 3 SP-tagged notes spread across 3 single-note phrases,
 *     each contributing 0.25 SP fill so the player can clear the 0.5
 *     activation threshold by the second SP note (t=26.0 s) and
 *     experience SP refilling on the third (t=28.5 s) if they activated.
 *
 * The final note ends at 28.5 s; the scene gives a 4.5-second "you're ready"
 * coda before auto-returning to the title at 33 s.
 */

import type { ChartV1 } from '@bongos-hero/shared';

export const tutorialChart: ChartV1 = {
  version: 1,
  audioOffsetMs: 0,
  bpm: 100,
  notes: [
    // Lane intro: 5 alternating notes, ~700 ms apart.
    { tMs: 3000, lane: 'L' },
    { tMs: 3700, lane: 'R' },
    { tMs: 4400, lane: 'L' },
    { tMs: 5100, lane: 'R' },
    { tMs: 5800, lane: 'L' },
    // Sustains: 1.5-second holds on each lane, separated so the player
    // releases one before reaching for the other.
    { tMs: 14500, lane: 'L', durMs: 1500 },
    { tMs: 17500, lane: 'R', durMs: 1500 },
    // Star-Power demo. Each `sp:true` note sits in its own single-note
    // phrase (the intervening non-sp notes break the run), so each clean
    // hit awards a full 0.25 of meter — two are enough to activate.
    { tMs: 23000, lane: 'L', sp: true },
    { tMs: 24500, lane: 'R' },
    { tMs: 26000, lane: 'L', sp: true },
    { tMs: 27500, lane: 'R' },
    { tMs: 28500, lane: 'L', sp: true },
  ],
};
