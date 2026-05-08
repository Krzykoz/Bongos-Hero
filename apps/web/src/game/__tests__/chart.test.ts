import { describe, expect, it } from 'vitest';

import type { ChartNote, ChartV1 } from '@bongos-hero/shared';

import { prepareChart } from '../chart.js';

function denseChart(): ChartV1 {
  // 20 alternating-lane notes spaced 100 ms apart. This is dense enough that
  // both `easy` (320 ms) and `medium` (180 ms) must drop notes, while `hard`
  // (0 ms) must keep every one.
  const notes: ChartNote[] = [];
  for (let i = 0; i < 20; i++) {
    notes.push({ tMs: 1000 + i * 100, lane: i % 2 === 0 ? 'L' : 'R' });
  }
  return { version: 1, audioOffsetMs: 0, notes };
}

function spacings(notes: readonly ChartNote[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < notes.length; i++) {
    out.push(notes[i]!.tMs - notes[i - 1]!.tMs);
  }
  return out;
}

describe('prepareChart difficulty thinning', () => {
  it('hard preserves every input note', () => {
    const chart = denseChart();
    const prepared = prepareChart(chart, 'hard');
    expect(prepared.playableChart.notes).toHaveLength(chart.notes.length);
    expect(prepared.playableChart.notes).toEqual(chart.notes);
  });

  it('medium keeps no two consecutive notes within 180 ms', () => {
    const chart = denseChart();
    const prepared = prepareChart(chart, 'medium');
    const gaps = spacings(prepared.playableChart.notes);
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(180);
    expect(prepared.playableChart.notes.length).toBeLessThan(chart.notes.length);
  });

  it('easy keeps no two consecutive notes within 320 ms', () => {
    const chart = denseChart();
    const prepared = prepareChart(chart, 'easy');
    const gaps = spacings(prepared.playableChart.notes);
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(320);
    expect(prepared.playableChart.notes.length).toBeLessThan(
      prepareChart(chart, 'medium').playableChart.notes.length,
    );
  });

  it('all difficulties preserve audioOffsetMs and bpm in the playable chart', () => {
    const chart: ChartV1 = {
      version: 1,
      audioOffsetMs: 25,
      bpm: 142,
      notes: denseChart().notes,
    };
    for (const d of ['easy', 'medium', 'hard'] as const) {
      const prepared = prepareChart(chart, d);
      expect(prepared.playableChart.audioOffsetMs).toBe(25);
      expect(prepared.playableChart.bpm).toBe(142);
      expect(prepared.playableChart.version).toBe(1);
    }
  });
});
