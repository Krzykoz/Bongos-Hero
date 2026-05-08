/**
 * Shared types between the Bongos Hero web client and server.
 * All timing values are in milliseconds unless explicitly suffixed.
 */

export type Lane = 'L' | 'R';

export interface ChartNote {
  /** Time of the note in milliseconds, from the start of the audio. */
  tMs: number;
  /** Which bongo the note belongs to. */
  lane: Lane;
  /** True if this note is part of a Star-Power phrase. */
  sp?: boolean;
  /**
   * When present and > 0, this is a "sustain" note: the player must hold the
   * lane key from `tMs` for `durMs` milliseconds. Renderers draw a trail
   * extending up from the note head; the scoring engine awards a per-second
   * bonus on a clean release and breaks combo on an early release.
   *
   * Older charts predate this field, so it is optional for backward
   * compatibility; consumers default it to 0 when undefined.
   */
  durMs?: number;
}

export interface ChartSection {
  /** Section start in milliseconds, inclusive. */
  startMs: number;
  /** Section end in milliseconds, exclusive (or song end for the last). */
  endMs: number;
  /** Mean smoothed RMS for the span, normalised to 0..1 across the song. */
  intensity: number;
}

export interface ChartV1 {
  version: 1;
  /** Constant offset to add to every note time before judging (calibration). */
  audioOffsetMs: number;
  /** Optional detected tempo, used by the background animation. */
  bpm?: number;
  /** Notes sorted ascending by tMs. */
  notes: ChartNote[];
  /**
   * Optional detected verse/chorus-like sections, in ascending order, covering
   * the entire song without gaps. Older charts predate this field, so it is
   * optional for backward compatibility.
   */
  sections?: ChartSection[];
}

export interface SongMeta {
  id: string;
  title: string;
  artist?: string;
  sourceUrl: string;
  durationMs: number;
  /** ISO timestamp. */
  createdAt: string;
}

// ---- Job / API types ----

export type JobStatus = 'queued' | 'downloading' | 'transcoding' | 'charting' | 'done' | 'error';

export interface JobState {
  id: string;
  status: JobStatus;
  /** 0..1 progress of the current step (best-effort). */
  progress: number;
  songId?: string;
  error?: string;
  sourceUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImportRequest {
  url: string;
}

export interface ImportResponse {
  jobId: string;
}

// ---- Game-side types (shared so the chart format stays in lockstep) ----

export type Judgment = 'perfect' | 'great' | 'good' | 'miss';

export const JUDGMENT_WINDOW_MS: Record<Exclude<Judgment, 'miss'>, number> = {
  perfect: 35,
  great: 70,
  good: 110,
};

export const JUDGMENT_SCORE: Record<Judgment, number> = {
  perfect: 50,
  great: 35,
  good: 20,
  miss: 0,
};

// ---- Difficulty -------------------------------------------------------------

export type Difficulty = 'easy' | 'medium' | 'hard';

export const DIFFICULTY_LIST: readonly Difficulty[] = ['easy', 'medium', 'hard'];

export interface DifficultyConfig {
  label: string;
  /**
   * Greedy minimum spacing (ms) between consecutive playable notes when
   * filtering a raw chart down for this difficulty. 0 = no filtering.
   */
  minSpacingMs: number;
  /** Multiplier applied to every score award. */
  scoreMultiplier: number;
}

export const DIFFICULTY_CONFIG: Record<Difficulty, DifficultyConfig> = {
  easy: { label: 'Easy', minSpacingMs: 320, scoreMultiplier: 0.6 },
  medium: { label: 'Medium', minSpacingMs: 180, scoreMultiplier: 0.85 },
  hard: { label: 'Hard', minSpacingMs: 0, scoreMultiplier: 1.0 },
};

export function isDifficulty(value: unknown): value is Difficulty {
  return value === 'easy' || value === 'medium' || value === 'hard';
}
