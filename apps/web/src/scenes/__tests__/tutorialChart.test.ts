import { describe, expect, it } from 'vitest';

import { prepareChart } from '../../game/chart.js';
import { tutorialChart } from '../tutorialChart.js';

describe('tutorialChart', () => {
  it('matches the ChartV1 shape required by the engine', () => {
    expect(tutorialChart.version).toBe(1);
    expect(typeof tutorialChart.audioOffsetMs).toBe('number');
    expect(Number.isFinite(tutorialChart.audioOffsetMs)).toBe(true);
    expect(Array.isArray(tutorialChart.notes)).toBe(true);
    for (const note of tutorialChart.notes) {
      expect(typeof note.tMs).toBe('number');
      expect(Number.isFinite(note.tMs)).toBe(true);
      expect(note.lane === 'L' || note.lane === 'R').toBe(true);
      if (note.durMs !== undefined) {
        expect(Number.isFinite(note.durMs)).toBe(true);
        expect(note.durMs).toBeGreaterThanOrEqual(0);
      }
      if (note.sp !== undefined) {
        expect(typeof note.sp).toBe('boolean');
      }
    }
  });

  it('has at least 8 notes (covers minimum playable density)', () => {
    expect(tutorialChart.notes.length).toBeGreaterThanOrEqual(8);
  });

  it('contains at least one sustain note (durMs > 0)', () => {
    const sustains = tutorialChart.notes.filter((n) => (n.durMs ?? 0) > 0);
    expect(sustains.length).toBeGreaterThanOrEqual(1);
  });

  it('contains at least 2 Star-Power notes (sp === true)', () => {
    const sp = tutorialChart.notes.filter((n) => n.sp === true);
    expect(sp.length).toBeGreaterThanOrEqual(2);
  });

  it('places every note within the [0, 35000] ms tutorial window', () => {
    for (const note of tutorialChart.notes) {
      expect(note.tMs).toBeGreaterThanOrEqual(0);
      expect(note.tMs).toBeLessThanOrEqual(35_000);
      // Sustains must also END inside the window so the auto-close in
      // ScoringEngine never trails past the auto-exit deadline.
      const endMs = note.tMs + (note.durMs ?? 0);
      expect(endMs).toBeLessThanOrEqual(35_000);
    }
  });

  it('keeps notes sorted ascending by tMs', () => {
    for (let i = 1; i < tutorialChart.notes.length; i++) {
      const prev = tutorialChart.notes[i - 1]!;
      const cur = tutorialChart.notes[i]!;
      expect(cur.tMs).toBeGreaterThanOrEqual(prev.tMs);
    }
  });

  it('survives prepareChart (every difficulty) without errors', () => {
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const prepared = prepareChart(tutorialChart, difficulty);
      expect(prepared.totalNotes).toBeGreaterThan(0);
      expect(prepared.playableChart.version).toBe(1);
      expect(prepared.playableChart.audioOffsetMs).toBe(tutorialChart.audioOffsetMs);
    }
  });
});
