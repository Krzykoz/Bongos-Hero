import { describe, expect, it } from 'vitest';

import {
  DIFFICULTY_CONFIG,
  DIFFICULTY_LIST,
  isDifficulty,
  JUDGMENT_SCORE,
  JUDGMENT_WINDOW_MS,
  type Difficulty,
} from '../index.js';

describe('JUDGMENT_WINDOW_MS', () => {
  it('orders perfect < great < good (tighter judgments are stricter)', () => {
    expect(JUDGMENT_WINDOW_MS.perfect).toBeLessThan(JUDGMENT_WINDOW_MS.great);
    expect(JUDGMENT_WINDOW_MS.great).toBeLessThan(JUDGMENT_WINDOW_MS.good);
  });

  it('uses positive millisecond values', () => {
    for (const v of Object.values(JUDGMENT_WINDOW_MS)) {
      expect(v).toBeGreaterThan(0);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('JUDGMENT_SCORE', () => {
  it('orders perfect > great > good > miss', () => {
    expect(JUDGMENT_SCORE.perfect).toBeGreaterThan(JUDGMENT_SCORE.great);
    expect(JUDGMENT_SCORE.great).toBeGreaterThan(JUDGMENT_SCORE.good);
    expect(JUDGMENT_SCORE.good).toBeGreaterThan(JUDGMENT_SCORE.miss);
  });

  it('miss is worth zero', () => {
    expect(JUDGMENT_SCORE.miss).toBe(0);
  });
});

describe('DIFFICULTY_CONFIG', () => {
  it('has one entry per difficulty in DIFFICULTY_LIST', () => {
    const cfgKeys = Object.keys(DIFFICULTY_CONFIG).sort();
    const listKeys = [...DIFFICULTY_LIST].sort();
    expect(cfgKeys).toEqual(listKeys);
  });

  it.each(['easy', 'medium', 'hard'] as const)('row %s has the expected shape', (d) => {
    const cfg = DIFFICULTY_CONFIG[d];
    expect(typeof cfg.label).toBe('string');
    expect(cfg.label.length).toBeGreaterThan(0);
    expect(typeof cfg.minSpacingMs).toBe('number');
    expect(cfg.minSpacingMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(cfg.minSpacingMs)).toBe(true);
    expect(typeof cfg.scoreMultiplier).toBe('number');
    expect(cfg.scoreMultiplier).toBeGreaterThan(0);
    expect(Number.isFinite(cfg.scoreMultiplier)).toBe(true);
  });

  it('hard does no spacing filtering', () => {
    expect(DIFFICULTY_CONFIG.hard.minSpacingMs).toBe(0);
  });

  it('easier difficulties thin more aggressively', () => {
    expect(DIFFICULTY_CONFIG.easy.minSpacingMs).toBeGreaterThan(
      DIFFICULTY_CONFIG.medium.minSpacingMs,
    );
    expect(DIFFICULTY_CONFIG.medium.minSpacingMs).toBeGreaterThan(
      DIFFICULTY_CONFIG.hard.minSpacingMs,
    );
  });
});

describe('isDifficulty', () => {
  it.each(['easy', 'medium', 'hard'] as const)('accepts %s', (d) => {
    expect(isDifficulty(d)).toBe(true);
  });

  it.each([null, undefined, '', 'EASY', 'expert', 0, 1, {}, []])('rejects %p', (v) => {
    expect(isDifficulty(v)).toBe(false);
  });

  it('narrows the input type', () => {
    const raw: unknown = 'medium';
    if (isDifficulty(raw)) {
      const _typed: Difficulty = raw;
      void _typed;
    }
    expect(isDifficulty(raw)).toBe(true);
  });
});
