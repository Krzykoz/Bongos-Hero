import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addToSetlist,
  clearSetlist,
  getCumulative,
  getSetlist,
  peekNext,
  popNext,
  recordResult,
  removeFromSetlist,
  resetCumulative,
  subscribe,
  type SetlistState,
} from '../setlist.js';

class MemoryStorage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  key(i: number): string | null {
    const keys = Array.from(this.store.keys());
    return keys[i] ?? null;
  }
}

const localStore = new MemoryStorage();
const sessionStore = new MemoryStorage();

beforeEach(() => {
  localStore.clear();
  sessionStore.clear();
  vi.stubGlobal('localStorage', localStore);
  vi.stubGlobal('sessionStorage', sessionStore);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('setlist queue', () => {
  it('starts empty when storage is empty', () => {
    expect(getSetlist()).toEqual([]);
    expect(peekNext()).toBeNull();
    expect(popNext()).toBeNull();
  });

  it('addToSetlist persists to localStorage and is idempotent per (songId,difficulty)', () => {
    const after1 = addToSetlist('song-a', 'easy');
    expect(after1).toHaveLength(1);
    expect(after1[0]?.songId).toBe('song-a');
    expect(after1[0]?.difficulty).toBe('easy');

    const after2 = addToSetlist('song-a', 'easy');
    expect(after2).toHaveLength(1);

    const after3 = addToSetlist('song-a', 'hard');
    expect(after3).toHaveLength(2);

    const raw = localStore.getItem('bongos.setlist');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? '[]') as { songId: string; difficulty: string }[];
    expect(parsed.map((e) => `${e.songId}/${e.difficulty}`)).toEqual([
      'song-a/easy',
      'song-a/hard',
    ]);
  });

  it('removeFromSetlist removes the matching entry only', () => {
    addToSetlist('song-a', 'easy');
    addToSetlist('song-b', 'medium');
    addToSetlist('song-a', 'hard');

    const after = removeFromSetlist('song-a', 'easy');
    expect(after.map((e) => `${e.songId}/${e.difficulty}`)).toEqual([
      'song-b/medium',
      'song-a/hard',
    ]);

    const noop = removeFromSetlist('song-x', 'easy');
    expect(noop).toHaveLength(2);
  });

  it('popNext returns and removes the head; peekNext does not mutate', () => {
    addToSetlist('song-a', 'easy');
    addToSetlist('song-b', 'medium');

    expect(peekNext()?.songId).toBe('song-a');
    expect(getSetlist()).toHaveLength(2);

    const popped = popNext();
    expect(popped?.songId).toBe('song-a');
    expect(getSetlist()).toHaveLength(1);
    expect(peekNext()?.songId).toBe('song-b');

    expect(popNext()?.songId).toBe('song-b');
    expect(popNext()).toBeNull();
  });

  it('clearSetlist empties queue + cumulative', () => {
    addToSetlist('song-a', 'easy');
    recordResult(1000, 3);

    clearSetlist();

    expect(getSetlist()).toEqual([]);
    expect(getCumulative()).toEqual({ score: 0, stars: 0, songsPlayed: 0 });
    expect(localStore.getItem('bongos.setlist')).toBeNull();
    expect(sessionStore.getItem('bongos.setlistScore')).toBeNull();
  });

  it('discards corrupt localStorage payload', () => {
    localStore.setItem('bongos.setlist', '{"not":"an array"}');
    expect(getSetlist()).toEqual([]);

    localStore.setItem('bongos.setlist', 'not json at all');
    expect(getSetlist()).toEqual([]);

    localStore.setItem(
      'bongos.setlist',
      JSON.stringify([{ songId: 'song-a', difficulty: 'easy', addedAt: '2024-01-01T00:00:00Z' }]),
    );
    expect(getSetlist()).toHaveLength(1);
  });

  it('drops invalid entries on load but keeps valid ones', () => {
    localStore.setItem(
      'bongos.setlist',
      JSON.stringify([
        { songId: 'song-a', difficulty: 'easy', addedAt: 'x' },
        { songId: 'song-b', difficulty: 'bogus', addedAt: 'x' },
        { songId: '', difficulty: 'easy', addedAt: 'x' },
        { songId: 'song-c', difficulty: 'hard', addedAt: 'x' },
      ]),
    );
    expect(getSetlist().map((e) => e.songId)).toEqual(['song-a', 'song-c']);
  });
});

describe('cumulative score', () => {
  it('recordResult sums score+stars and increments songsPlayed', () => {
    recordResult(1000, 3);
    expect(getCumulative()).toEqual({ score: 1000, stars: 3, songsPlayed: 1 });

    recordResult(500, 5);
    expect(getCumulative()).toEqual({ score: 1500, stars: 8, songsPlayed: 2 });
  });

  it('coerces non-finite inputs to zero but still increments songsPlayed', () => {
    recordResult(Number.NaN, Number.POSITIVE_INFINITY);
    expect(getCumulative()).toEqual({ score: 0, stars: 0, songsPlayed: 1 });
  });

  it('persists to sessionStorage between calls', () => {
    recordResult(200, 2);
    const raw = sessionStore.getItem('bongos.setlistScore');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '{}')).toEqual({ score: 200, stars: 2, songsPlayed: 1 });
  });

  it('discards corrupt cumulative payload', () => {
    sessionStore.setItem('bongos.setlistScore', '{"score":"not a number"}');
    expect(getCumulative()).toEqual({ score: 0, stars: 0, songsPlayed: 0 });
  });

  it('resetCumulative clears score but leaves queue intact', () => {
    addToSetlist('song-a', 'easy');
    recordResult(900, 4);

    resetCumulative();

    expect(getCumulative()).toEqual({ score: 0, stars: 0, songsPlayed: 0 });
    expect(getSetlist()).toHaveLength(1);
  });
});

describe('subscribe', () => {
  it('fires synchronously on subscribe and again on every mutation', () => {
    const states: SetlistState[] = [];
    const unsub = subscribe((s) => states.push(s));

    expect(states).toHaveLength(1);
    expect(states[0]?.queue).toEqual([]);
    expect(states[0]?.songsPlayed).toBe(0);

    addToSetlist('song-a', 'easy');
    expect(states).toHaveLength(2);
    expect(states[1]?.queue).toHaveLength(1);

    recordResult(100, 1);
    expect(states).toHaveLength(3);
    expect(states[2]?.cumulativeScore).toBe(100);

    popNext();
    expect(states).toHaveLength(4);
    expect(states[3]?.queue).toEqual([]);

    unsub();
    addToSetlist('song-b', 'hard');
    expect(states).toHaveLength(4);
  });

  it('isolates subscriber errors', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ok: SetlistState[] = [];

    const unsub1 = subscribe(() => {
      throw new Error('boom');
    });
    const unsub2 = subscribe((s) => ok.push(s));

    addToSetlist('song-a', 'easy');
    expect(ok.length).toBeGreaterThanOrEqual(2);

    unsub1();
    unsub2();
    errSpy.mockRestore();
  });
});
