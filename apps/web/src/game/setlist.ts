/**
 * Setlist queue + cumulative-score store.
 *
 * The setlist is a player-curated queue of `(songId, difficulty)` entries
 * that drives auto-advance on the results screen. Two storage tiers:
 *
 *   - Queue (`localStorage['bongos.setlist']`): persisted across reloads.
 *   - Cumulative score (`sessionStorage['bongos.setlistScore']`): per-tab,
 *     so it resets when the tab closes — same lifetime as one "session"
 *     of back-to-back songs.
 *
 * Every storage access is wrapped in try/catch (private-mode browsers
 * throw on writes) and every load defensively re-validates the JSON
 * shape. A corrupt payload is silently dropped and replaced with the
 * empty value rather than thrown — gameplay never crashes because of a
 * tampered setlist.
 *
 * `subscribe(cb)` mirrors the convention used by `settings/index.ts`:
 * the callback fires synchronously on subscribe with the current state,
 * so callers can use the same code path for "render once now" and
 * "re-render on every change".
 *
 * The reads-from-storage-on-every-call shape is deliberate — the
 * payloads are tiny, and not caching means the public API stays
 * stateless and trivially testable.
 */

import { isDifficulty, type Difficulty } from '@bongos-hero/shared';

const QUEUE_KEY = 'bongos.setlist';
const SCORE_KEY = 'bongos.setlistScore';

export interface SetlistEntry {
  songId: string;
  difficulty: Difficulty;
  /** ISO timestamp of when the entry was added. */
  addedAt: string;
}

export interface CumulativeScore {
  score: number;
  stars: number;
  songsPlayed: number;
}

export interface SetlistState {
  queue: SetlistEntry[];
  cumulativeScore: number;
  cumulativeStars: number;
  songsPlayed: number;
}

const EMPTY_CUMULATIVE: CumulativeScore = { score: 0, stars: 0, songsPlayed: 0 };

const subscribers = new Set<(state: SetlistState) => void>();

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isSetlistEntry(v: unknown): v is SetlistEntry {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.songId === 'string' &&
    o.songId.length > 0 &&
    isDifficulty(o.difficulty) &&
    typeof o.addedAt === 'string'
  );
}

function isCumulativeScore(v: unknown): v is CumulativeScore {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return isFiniteNumber(o.score) && isFiniteNumber(o.stars) && isFiniteNumber(o.songsPlayed);
}

function safeRemoveLocal(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // ignore
  }
}

function safeRemoveSession(key: string): void {
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
    // ignore
  }
}

function readQueueFromStorage(): SetlistEntry[] {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(QUEUE_KEY) ?? null;
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeRemoveLocal(QUEUE_KEY);
    return [];
  }
  if (!Array.isArray(parsed)) {
    safeRemoveLocal(QUEUE_KEY);
    return [];
  }
  const cleaned: SetlistEntry[] = [];
  for (const item of parsed) {
    if (isSetlistEntry(item)) {
      cleaned.push({
        songId: item.songId,
        difficulty: item.difficulty,
        addedAt: item.addedAt,
      });
    }
  }
  return cleaned;
}

function writeQueueToStorage(queue: SetlistEntry[]): void {
  try {
    globalThis.localStorage?.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // private mode / quota — best effort.
  }
}

function readCumulativeFromStorage(): CumulativeScore {
  let raw: string | null = null;
  try {
    raw = globalThis.sessionStorage?.getItem(SCORE_KEY) ?? null;
  } catch {
    return { ...EMPTY_CUMULATIVE };
  }
  if (raw === null) return { ...EMPTY_CUMULATIVE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeRemoveSession(SCORE_KEY);
    return { ...EMPTY_CUMULATIVE };
  }
  if (!isCumulativeScore(parsed)) {
    safeRemoveSession(SCORE_KEY);
    return { ...EMPTY_CUMULATIVE };
  }
  return { score: parsed.score, stars: parsed.stars, songsPlayed: parsed.songsPlayed };
}

function writeCumulativeToStorage(c: CumulativeScore): void {
  try {
    globalThis.sessionStorage?.setItem(SCORE_KEY, JSON.stringify(c));
  } catch {
    // best effort
  }
}

function snapshotState(): SetlistState {
  const queue = readQueueFromStorage();
  const c = readCumulativeFromStorage();
  return {
    queue,
    cumulativeScore: c.score,
    cumulativeStars: c.stars,
    songsPlayed: c.songsPlayed,
  };
}

function notify(): void {
  const snapshot = Array.from(subscribers);
  const view = snapshotState();
  for (const cb of snapshot) {
    try {
      cb(view);
    } catch (err) {
      console.error('[setlist] subscriber threw:', err);
    }
  }
}

function indexOf(queue: SetlistEntry[], songId: string, difficulty: Difficulty): number {
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    if (entry?.songId === songId && entry.difficulty === difficulty) {
      return i;
    }
  }
  return -1;
}

export function getSetlist(): SetlistEntry[] {
  return readQueueFromStorage();
}

export function addToSetlist(songId: string, difficulty: Difficulty): SetlistEntry[] {
  const queue = readQueueFromStorage();
  if (indexOf(queue, songId, difficulty) >= 0) return queue;
  const entry: SetlistEntry = {
    songId,
    difficulty,
    addedAt: new Date().toISOString(),
  };
  const next = [...queue, entry];
  writeQueueToStorage(next);
  notify();
  return next;
}

export function removeFromSetlist(songId: string, difficulty: Difficulty): SetlistEntry[] {
  const queue = readQueueFromStorage();
  const idx = indexOf(queue, songId, difficulty);
  if (idx < 0) return queue;
  const next = queue.slice(0, idx).concat(queue.slice(idx + 1));
  writeQueueToStorage(next);
  notify();
  return next;
}

export function clearSetlist(): void {
  safeRemoveLocal(QUEUE_KEY);
  safeRemoveSession(SCORE_KEY);
  notify();
}

export function popNext(): SetlistEntry | null {
  const queue = readQueueFromStorage();
  const head = queue[0];
  if (head === undefined) return null;
  const next = queue.slice(1);
  writeQueueToStorage(next);
  notify();
  return head;
}

export function peekNext(): SetlistEntry | null {
  return readQueueFromStorage()[0] ?? null;
}

export function getCumulative(): CumulativeScore {
  return readCumulativeFromStorage();
}

export function recordResult(score: number, stars: number): void {
  const safeScore = isFiniteNumber(score) ? score : 0;
  const safeStars = isFiniteNumber(stars) ? stars : 0;
  const prev = readCumulativeFromStorage();
  const next: CumulativeScore = {
    score: prev.score + safeScore,
    stars: prev.stars + safeStars,
    songsPlayed: prev.songsPlayed + 1,
  };
  writeCumulativeToStorage(next);
  notify();
}

export function resetCumulative(): void {
  safeRemoveSession(SCORE_KEY);
  notify();
}

/**
 * Subscribe to setlist state changes. The callback is invoked
 * SYNCHRONOUSLY with the current state on subscribe so callers can use
 * the same code path for "render once now" and "render on every change".
 * Returns an unsubscribe function.
 */
export function subscribe(cb: (state: SetlistState) => void): () => void {
  subscribers.add(cb);
  try {
    cb(snapshotState());
  } catch (err) {
    console.error('[setlist] subscriber threw on initial dispatch:', err);
  }
  return (): void => {
    subscribers.delete(cb);
  };
}
