/**
 * Per-song × difficulty high-score store.
 *
 * Each `(songId, difficulty)` pair is stored as a single JSON `HighScoreEntry`
 * under `bongos.highScores.<songId>.<difficulty>` in `localStorage`. The store
 * is best-effort: every read/write is wrapped in try/catch so private-mode
 * browsers (which throw on writes) never crash gameplay, and any malformed
 * payload is silently dropped on load.
 *
 * "Best" is ordered by `score`, then `stars`, then `accuracyPct`.
 */

import { isDifficulty, type Difficulty } from '@bongos-hero/shared';

const KEY_PREFIX = 'bongos.highScores.';

export interface HighScoreEntry {
  score: number;
  accuracyPct: number;
  stars: number;
  perfect: number;
  great: number;
  good: number;
  miss: number;
  achievedAt: string;
}

export interface HighScoreSnapshotInput {
  score: number;
  accuracyPct: number;
  stars: number;
  judgmentCounts: { perfect: number; great: number; good: number; miss: number };
}

export interface SaveResult {
  wasNew: boolean;
  current: HighScoreEntry;
  previous: HighScoreEntry | null;
}

function storageKey(songId: string, difficulty: Difficulty): string {
  return `${KEY_PREFIX}${songId}.${difficulty}`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isHighScoreEntry(v: unknown): v is HighScoreEntry {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    isFiniteNumber(o.score) &&
    isFiniteNumber(o.accuracyPct) &&
    isFiniteNumber(o.stars) &&
    isFiniteNumber(o.perfect) &&
    isFiniteNumber(o.great) &&
    isFiniteNumber(o.good) &&
    isFiniteNumber(o.miss) &&
    typeof o.achievedAt === 'string'
  );
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function loadBest(songId: string, difficulty: Difficulty): HighScoreEntry | null {
  const key = storageKey(songId, difficulty);
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeRemove(key);
    return null;
  }
  if (!isHighScoreEntry(parsed)) {
    safeRemove(key);
    return null;
  }
  return parsed;
}

function isBetter(candidate: HighScoreEntry, incumbent: HighScoreEntry): boolean {
  if (candidate.score !== incumbent.score) return candidate.score > incumbent.score;
  if (candidate.stars !== incumbent.stars) return candidate.stars > incumbent.stars;
  return candidate.accuracyPct > incumbent.accuracyPct;
}

export function saveIfBest(
  songId: string,
  difficulty: Difficulty,
  snap: HighScoreSnapshotInput,
): SaveResult {
  const previous = loadBest(songId, difficulty);

  const candidate: HighScoreEntry = {
    score: snap.score,
    accuracyPct: snap.accuracyPct,
    stars: snap.stars,
    perfect: snap.judgmentCounts.perfect,
    great: snap.judgmentCounts.great,
    good: snap.judgmentCounts.good,
    miss: snap.judgmentCounts.miss,
    achievedAt: new Date().toISOString(),
  };

  if (previous !== null && !isBetter(candidate, previous)) {
    return { wasNew: false, current: previous, previous };
  }

  try {
    window.localStorage.setItem(storageKey(songId, difficulty), JSON.stringify(candidate));
  } catch {
    // Persisting failed (private mode, quota, etc.). The result still reflects
    // what would have been the new best so the UI can show "NEW BEST!" — but
    // future loads will return whatever the previous value was (or null).
  }

  return { wasNew: true, current: candidate, previous };
}

export function clearScores(songId?: string): void {
  let keys: string[];
  try {
    keys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k !== null) keys.push(k);
    }
  } catch {
    return;
  }

  const prefix = songId === undefined ? KEY_PREFIX : `${KEY_PREFIX}${songId}.`;
  for (const k of keys) {
    if (!k.startsWith(prefix)) continue;
    if (songId === undefined) {
      const tail = k.slice(KEY_PREFIX.length);
      const dot = tail.lastIndexOf('.');
      if (dot < 0) continue;
      const diff = tail.slice(dot + 1);
      if (!isDifficulty(diff)) continue;
    } else {
      const diff = k.slice(prefix.length);
      if (!isDifficulty(diff)) continue;
    }
    safeRemove(k);
  }
}
