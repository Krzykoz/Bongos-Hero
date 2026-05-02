/**
 * Persisted difficulty preference (localStorage).
 *
 * Selected on the song-select scene, threaded through the play scene as
 * payload, and surfaced on the results screen.
 */

import { isDifficulty, type Difficulty } from '@bongos-hero/shared';

const STORAGE_KEY = 'bongos.difficulty';
const DEFAULT_DIFFICULTY: Difficulty = 'medium';

export function loadDifficulty(): Difficulty {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null && isDifficulty(raw)) return raw;
  } catch {
    // localStorage unavailable (private mode, etc.) — fall through.
  }
  return DEFAULT_DIFFICULTY;
}

export function saveDifficulty(d: Difficulty): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, d);
  } catch {
    // Best-effort; ignore failures.
  }
}
