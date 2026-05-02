/**
 * Results scene.
 *
 * Displays the final score (animated count-up over 1.5 s), per-judgment
 * breakdown, accuracy %, max combo, difficulty, and a 0–5-star rating
 * computed from accuracy. Two buttons: "Play again" re-enters the play
 * scene with the same songId AND difficulty, "Song select" returns to the
 * list.
 *
 * Background renderer continues its idle loop so the screen never goes dead.
 */

import './scenes.css';
import {
  DIFFICULTY_CONFIG,
  isDifficulty,
  type Difficulty,
  type SongMeta,
} from '@bongos-hero/shared';

import { computeStars } from '../game/state.js';
import type { ScoringSnapshot } from '../game/scoring.js';
import type { Scene, SceneContext } from '../router.js';
import { el, fmtNumber } from './dom.js';
import { BackgroundRenderer } from '../render/background.js';

interface ResultsPayload {
  songMeta: SongMeta | null;
  snapshot: ScoringSnapshot;
  songId: string;
  difficulty?: Difficulty;
}

let bg: BackgroundRenderer | null = null;
let root: HTMLDivElement | null = null;
let scoreEl: HTMLDivElement | null = null;
let onKeyDown: ((ev: KeyboardEvent) => void) | null = null;

let countUpStartMs = 0;
let payloadCache: ResultsPayload | null = null;

const COUNT_UP_DURATION_MS = 1500;

function ensureBackground(): BackgroundRenderer {
  if (!bg) {
    bg = new BackgroundRenderer();
    bg.setBpm(120);
  }
  return bg;
}

function computeAccuracy(s: ScoringSnapshot): number {
  if (s.notesPlayed === 0) return 0;
  const max = s.notesPlayed * 50;
  const earned = s.hits.perfect * 50 + s.hits.great * 35 + s.hits.good * 20;
  return (earned / max) * 100;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function buildStars(stars: number): HTMLSpanElement {
  const span = el('span', { className: 'bh-results-stars' });
  for (let i = 0; i < 5; i++) {
    const filled = i < stars;
    const star = el(
      'span',
      { className: filled ? 'bh-star-filled' : 'bh-star-empty' },
      [filled ? '★ ' : '☆ '],
    );
    span.appendChild(star);
  }
  return span;
}

function buildStat(label: string, value: string): HTMLDivElement {
  return el('div', { className: 'bh-results-stat' }, [
    el('span', { className: 'bh-stat-label' }, [label]),
    el('span', { className: 'bh-stat-value' }, [value]),
  ]);
}

export const resultsScene: Scene = {
  enter(sceneCtx: SceneContext): void {
    ensureBackground();

    const payload = sceneCtx.payload as ResultsPayload | undefined;
    if (!payload || !payload.snapshot) {
      // No payload — bounce back.
      sceneCtx.navigate('songSelect');
      return;
    }
    payloadCache = payload;
    countUpStartMs = performance.now();

    const snap = payload.snapshot;
    const accuracy = computeAccuracy(snap);
    const stars = computeStars(accuracy);
    const difficulty: Difficulty = isDifficulty(payload.difficulty)
      ? payload.difficulty
      : 'medium';
    const difficultyLabel = DIFFICULTY_CONFIG[difficulty].label;

    scoreEl = el('div', { className: 'bh-results-score' }, ['0']);

    const replayPayload = { songId: payload.songId, difficulty };

    const playAgainBtn = el(
      'button',
      { type: 'button', className: 'bh-btn bh-btn-primary' },
      ['Play again'],
    );
    playAgainBtn.addEventListener('click', () => {
      sceneCtx.navigate('play', replayPayload);
    });

    const songSelectBtn = el(
      'button',
      { type: 'button', className: 'bh-btn' },
      ['Song select'],
    );
    songSelectBtn.addEventListener('click', () => {
      sceneCtx.navigate('songSelect');
    });

    const titleText =
      payload.songMeta?.title && payload.songMeta.title.length > 0
        ? payload.songMeta.title
        : 'Unknown song';

    const titleEl = el('div', { className: 'bh-results-songtitle' }, [titleText]);

    const card = el('div', { className: 'bh-results-card' }, [
      el('h2', {}, ['RESULTS']),
      titleEl,
      scoreEl,
      buildStars(stars),
      el('div', { className: 'bh-results-stats' }, [
        buildStat('Difficulty', difficultyLabel),
        buildStat('Max combo', fmtNumber(snap.maxCombo)),
        buildStat('Accuracy', `${accuracy.toFixed(1)}%`),
        buildStat('Stars', `${stars}/5`),
        buildStat('Perfect', fmtNumber(snap.hits.perfect)),
        buildStat('Great', fmtNumber(snap.hits.great)),
        buildStat('Good', fmtNumber(snap.hits.good)),
        buildStat('Miss', fmtNumber(snap.hits.miss)),
        buildStat('Notes', `${snap.notesPlayed}/${snap.notesTotal}`),
        buildStat('Multiplier', `x${snap.multiplier}`),
      ]),
      el('div', { className: 'bh-results-actions' }, [songSelectBtn, playAgainBtn]),
    ]);

    root = el('div', { className: 'bh-results' }, [card]);
    sceneCtx.overlay.appendChild(root);

    onKeyDown = (ev: KeyboardEvent): void => {
      const target = ev.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      switch (ev.code) {
        case 'Enter':
        case 'KeyF':
        case 'KeyJ':
          ev.preventDefault();
          sceneCtx.navigate('play', replayPayload);
          return;
        case 'Escape':
          ev.preventDefault();
          sceneCtx.navigate('songSelect');
          return;
        default:
          return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
  },

  exit(sceneCtx: SceneContext): void {
    if (onKeyDown) {
      document.removeEventListener('keydown', onKeyDown);
      onKeyDown = null;
    }
    if (root) {
      root.remove();
      root = null;
    }
    scoreEl = null;
    payloadCache = null;
    void sceneCtx;
  },

  draw(sceneCtx: SceneContext, nowMs: number): void {
    ensureBackground().draw(sceneCtx.ctx, { nowMs });

    if (!scoreEl || !payloadCache) return;
    const elapsed = performance.now() - countUpStartMs;
    const t = Math.max(0, Math.min(1, elapsed / COUNT_UP_DURATION_MS));
    const final = payloadCache.snapshot.score;
    const value = Math.round(final * easeOutCubic(t));
    scoreEl.textContent = fmtNumber(value);
  },
};
