import { describe, expect, it } from 'vitest';

import { computeStars } from '../state.js';

describe('computeStars', () => {
  it.each([
    { accuracy: 0, stars: 0 },
    { accuracy: 39.99, stars: 0 },
    { accuracy: 40, stars: 1 },
    { accuracy: 54.99, stars: 1 },
    { accuracy: 55, stars: 2 },
    { accuracy: 69.99, stars: 2 },
    { accuracy: 70, stars: 3 },
    { accuracy: 81.99, stars: 3 },
    { accuracy: 82, stars: 4 },
    { accuracy: 92.99, stars: 4 },
    { accuracy: 93, stars: 5 },
    { accuracy: 100, stars: 5 },
  ])('$accuracy% → $stars stars', ({ accuracy, stars }) => {
    expect(computeStars(accuracy)).toBe(stars);
  });

  it('returns 0 for NaN input', () => {
    expect(computeStars(Number.NaN)).toBe(0);
  });

  it('returns 0 for negative accuracy', () => {
    expect(computeStars(-1)).toBe(0);
  });
});
