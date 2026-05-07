/**
 * Chart preparation helpers.
 *
 * `prepareChart` turns a raw `ChartV1` into a `PreparedChart` with
 * pre-computed per-note adjusted times and Star-Power phrase grouping.
 * Doing this once up-front means the scoring hot loop never has to
 * walk the chart looking for phrase boundaries or re-add `audioOffsetMs`.
 *
 * Difficulty is applied at this stage by greedily filtering the source
 * chart down to a sparser, playable set of notes. The same filtered chart
 * is used by both the scoring engine and the notes renderer so visuals
 * and judgment line up exactly.
 */

import type { ChartNote, ChartV1, Difficulty } from '@bongos-hero/shared';
import { DIFFICULTY_CONFIG } from '@bongos-hero/shared';

export interface PreparedChart {
  /** Original chart, unmodified. */
  chart: ChartV1;
  /**
   * Difficulty-adjusted chart: same metadata as `chart`, but with `notes`
   * filtered down per difficulty. Use this for both rendering and scoring.
   */
  playableChart: ChartV1;
  /** Difficulty applied to derive `playableChart`. */
  difficulty: Difficulty;
  /** Multiplier to apply to every score award (from DIFFICULTY_CONFIG). */
  difficultyMultiplier: number;
  /** notes[i].tMs + chart.audioOffsetMs, precomputed once for hot-loop use. */
  noteTimesAdjustedMs: number[];
  /** Convenience copy of `playableChart.notes.length`. */
  totalNotes: number;
  /** Phrase index per note (-1 if not in any phrase, ≥0 = SP phrase id). */
  phraseId: number[];
  /** For each phrase id: array of note indexes belonging to that phrase. */
  phrases: number[][];
}

/**
 * Build a `PreparedChart`. A "phrase" is a maximal run of consecutive
 * `sp:true` notes (any non-SP note breaks the run). Single-note SP phrases
 * are valid.
 *
 * @param chart Raw chart from the server.
 * @param difficulty Difficulty to play at; defaults to `'medium'`.
 */
export function prepareChart(chart: ChartV1, difficulty: Difficulty = 'medium'): PreparedChart {
  const cfg = DIFFICULTY_CONFIG[difficulty];
  const filteredNotes = filterNotesForDifficulty(chart.notes, cfg.minSpacingMs);

  const playableChart: ChartV1 = {
    version: chart.version,
    audioOffsetMs: chart.audioOffsetMs,
    notes: filteredNotes,
    ...(chart.bpm !== undefined ? { bpm: chart.bpm } : {}),
  };

  const offset = playableChart.audioOffsetMs;
  const total = filteredNotes.length;

  const adjusted: number[] = new Array<number>(total);
  const phraseId: number[] = new Array<number>(total);
  const phrases: number[][] = [];

  let currentPhrase: number[] | null = null;

  for (let i = 0; i < total; i++) {
    const note = filteredNotes[i];
    if (note === undefined) {
      adjusted[i] = 0;
      phraseId[i] = -1;
      currentPhrase = null;
      continue;
    }

    adjusted[i] = note.tMs + offset;

    if (note.sp === true) {
      if (currentPhrase === null) {
        currentPhrase = [];
        phrases.push(currentPhrase);
      }
      currentPhrase.push(i);
      phraseId[i] = phrases.length - 1;
    } else {
      phraseId[i] = -1;
      currentPhrase = null;
    }
  }

  return {
    chart,
    playableChart,
    difficulty,
    difficultyMultiplier: cfg.scoreMultiplier,
    noteTimesAdjustedMs: adjusted,
    totalNotes: total,
    phraseId,
    phrases,
  };
}

/**
 * Greedy minimum-spacing filter. Walks notes ascending by tMs and keeps the
 * first one. For each subsequent candidate that satisfies the spacing
 * constraint relative to the last kept note, prefer one that alternates lanes
 * if a same-lane candidate is followed shortly by an opposite-lane one — this
 * preserves the L↔R "groove" of the chart even when density is dropped.
 */
function filterNotesForDifficulty(notes: readonly ChartNote[], minSpacingMs: number): ChartNote[] {
  if (minSpacingMs <= 0 || notes.length === 0) return notes.slice();

  const altWindowMs = Math.min(60, Math.floor(minSpacingMs * 0.3));
  const kept: ChartNote[] = [];
  let i = 0;

  while (i < notes.length) {
    const candidate = notes[i];
    if (candidate === undefined) {
      i++;
      continue;
    }
    if (kept.length === 0) {
      kept.push(candidate);
      i++;
      continue;
    }

    const last = kept[kept.length - 1];
    if (last === undefined) {
      kept.push(candidate);
      i++;
      continue;
    }

    if (candidate.tMs - last.tMs < minSpacingMs) {
      i++;
      continue;
    }

    // Candidate is eligible. If it repeats the lane of the previous kept
    // note, peek ahead within `altWindowMs` for an alternating-lane note we
    // could pick instead.
    if (candidate.lane === last.lane) {
      let chosenIdx = i;
      for (let j = i + 1; j < notes.length; j++) {
        const peek = notes[j];
        if (peek === undefined) continue;
        if (peek.tMs - candidate.tMs > altWindowMs) break;
        if (peek.lane !== last.lane) {
          chosenIdx = j;
          break;
        }
      }
      const chosen = notes[chosenIdx];
      if (chosen !== undefined) kept.push(chosen);
      i = chosenIdx + 1;
    } else {
      kept.push(candidate);
      i++;
    }
  }

  return kept;
}
