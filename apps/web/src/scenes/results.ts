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
import { saveIfBest, type HighScoreEntry } from '../game/highScores.js';
import type { ScoringSnapshot } from '../game/scoring.js';
import {
  clearSetlist,
  getCumulative,
  peekNext,
  popNext,
  recordResult,
  resetCumulative,
  type SetlistEntry,
} from '../game/setlist.js';
import type { Scene, SceneContext } from '../router.js';
import { el, fmtNumber } from './dom.js';
import { BackgroundRenderer } from '../render/background.js';

interface ResultsPayload {
  songMeta: SongMeta | null;
  snapshot: ScoringSnapshot;
  songId: string;
  difficulty?: Difficulty;
  /** True when the run ended because the rock meter hit zero. */
  failed?: boolean;
}

let bg: BackgroundRenderer | null = null;
let root: HTMLDivElement | null = null;
let scoreEl: HTMLDivElement | null = null;
let onKeyDown: ((ev: KeyboardEvent) => void) | null = null;
let countdownIntervalId: ReturnType<typeof setInterval> | null = null;
let countdownLineEl: HTMLDivElement | null = null;
let countdownSeconds = 0;
let countdownNext: SetlistEntry | null = null;
let advanceTriggered = false;

let countUpStartMs = 0;
let payloadCache: ResultsPayload | null = null;

const COUNT_UP_DURATION_MS = 1500;
const AUTO_ADVANCE_SECONDS = 8;

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
    const star = el('span', { className: filled ? 'bh-star-filled' : 'bh-star-empty' }, [
      filled ? '★ ' : '☆ ',
    ]);
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

function formatPreviousBest(entry: HighScoreEntry): string {
  return `Previous best: ${fmtNumber(entry.score)} (${entry.stars}★, ${entry.accuracyPct.toFixed(1)}%)`;
}

function buildNewBestBanner(): HTMLDivElement {
  const banner = el('div', { className: 'bh-results-newbest' }, ['NEW BEST!']);
  banner.style.cssText = [
    'align-self:center',
    'padding:6px 18px',
    'border-radius:999px',
    'font:800 16px/1 Georgia,"Times New Roman",serif',
    'letter-spacing:0.18em',
    'color:#fff5e6',
    'background:linear-gradient(90deg,#5ad7ff 0%,#ffe16a 100%)',
    'box-shadow:0 0 18px rgba(90,215,255,0.6),0 0 24px rgba(255,225,106,0.45)',
    'text-shadow:0 0 6px rgba(0,0,0,0.35)',
    'opacity:0',
  ].join(';');
  banner.animate(
    [
      { opacity: 0, transform: 'translateY(-4px) scale(0.96)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ],
    { duration: 480, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' },
  );
  return banner;
}

function buildFailedBanner(): HTMLDivElement {
  const banner = el('div', { className: 'bh-results-failed' }, ['FAILED']);
  banner.style.cssText = [
    'align-self:center',
    'padding:8px 26px',
    'border-radius:999px',
    'font:900 28px/1 Georgia,"Times New Roman",serif',
    'letter-spacing:0.32em',
    'color:#fff5e6',
    'background:linear-gradient(90deg,#7a1d1d 0%,#ef4444 100%)',
    'box-shadow:0 0 22px rgba(239,68,68,0.65),0 0 30px rgba(239,68,68,0.45)',
    'text-shadow:0 0 8px rgba(0,0,0,0.45)',
    'opacity:0',
  ].join(';');
  banner.animate(
    [
      { opacity: 0, transform: 'translateY(-4px) scale(0.94)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ],
    { duration: 520, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' },
  );
  return banner;
}

function buildBestLine(text: string): HTMLDivElement {
  const line = el('div', { className: 'bh-results-bestline' }, [text]);
  line.style.cssText = [
    'font:500 13px/1.3 "Segoe UI",system-ui,sans-serif',
    'letter-spacing:0.05em',
    'color:rgba(245,240,227,0.7)',
    'margin-top:-4px',
  ].join(';');
  return line;
}

function clearCountdownTimer(): void {
  if (countdownIntervalId !== null) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }
}

function cancelAutoAdvance(): void {
  if (countdownIntervalId === null || advanceTriggered) return;
  clearCountdownTimer();
  if (countdownLineEl) {
    countdownLineEl.textContent = 'Auto-advance cancelled. Press Enter for next.';
  }
}

function buildSetlistPanel(
  next: SetlistEntry,
  onAdvance: () => void,
  onSkip: () => void,
): HTMLDivElement {
  countdownSeconds = AUTO_ADVANCE_SECONDS;
  countdownNext = next;

  const heading = el('div', { className: 'bh-setlist-next-heading' }, [
    `Next: ${next.songId} [${DIFFICULTY_CONFIG[next.difficulty].label}]`,
  ]);
  heading.style.cssText = [
    'font:700 14px/1.3 "Segoe UI",system-ui,sans-serif',
    'letter-spacing:0.05em',
    'color:#5ad7ff',
    'text-shadow:0 0 8px rgba(90,215,255,0.45)',
  ].join(';');

  countdownLineEl = el('div', { className: 'bh-setlist-countdown' }, [
    `Auto-advance in ${countdownSeconds}s…`,
  ]);
  countdownLineEl.style.cssText = [
    'font:500 13px/1.3 "Segoe UI",system-ui,sans-serif',
    'letter-spacing:0.05em',
    'color:rgba(245,240,227,0.85)',
  ].join(';');

  const skipBtn = el('button', { type: 'button', className: 'bh-btn bh-btn-primary' }, [
    'Skip → next song',
  ]);
  skipBtn.addEventListener('click', () => {
    if (advanceTriggered) return;
    advanceTriggered = true;
    clearCountdownTimer();
    onSkip();
  });

  const panel = el('div', { className: 'bh-setlist-next' }, [heading, countdownLineEl, skipBtn]);
  panel.style.cssText = [
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'gap:6px',
    'margin-top:4px',
    'padding:12px 18px',
    'border-radius:12px',
    'background:linear-gradient(180deg,rgba(20,40,70,0.55),rgba(10,20,40,0.55))',
    'border:1px solid rgba(90,215,255,0.45)',
    'box-shadow:0 0 14px rgba(90,215,255,0.25)',
  ].join(';');

  countdownIntervalId = setInterval(() => {
    countdownSeconds -= 1;
    if (countdownLineEl) {
      countdownLineEl.textContent =
        countdownSeconds > 0 ? `Auto-advance in ${countdownSeconds}s…` : 'Advancing to next song…';
    }
    if (countdownSeconds <= 0) {
      clearCountdownTimer();
      if (advanceTriggered) return;
      advanceTriggered = true;
      onAdvance();
    }
  }, 1000);

  return panel;
}

function buildSetlistCompletePanel(
  total: { score: number; stars: number; songsPlayed: number },
  onReset: () => void,
): HTMLDivElement {
  const heading = el('div', {}, ['Setlist complete!']);
  heading.style.cssText = [
    'font:800 18px/1.2 Georgia,"Times New Roman",serif',
    'letter-spacing:0.12em',
    'color:#ffe16a',
    'text-shadow:0 0 10px rgba(255,225,106,0.5)',
  ].join(';');

  const totals = el('div', {}, [
    `Total: ${fmtNumber(total.score)} (${total.stars}★ across ${total.songsPlayed} songs)`,
  ]);
  totals.style.cssText = [
    'font:600 14px/1.3 "Segoe UI",system-ui,sans-serif',
    'letter-spacing:0.04em',
    'color:rgba(245,240,227,0.9)',
  ].join(';');

  const resetBtn = el('button', { type: 'button', className: 'bh-btn' }, ['Reset setlist']);
  resetBtn.addEventListener('click', () => {
    onReset();
    if (resetBtn.parentElement) resetBtn.parentElement.remove();
  });

  const panel = el('div', { className: 'bh-setlist-complete' }, [heading, totals, resetBtn]);
  panel.style.cssText = [
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'gap:8px',
    'margin-top:4px',
    'padding:12px 18px',
    'border-radius:12px',
    'background:linear-gradient(180deg,rgba(60,40,20,0.55),rgba(40,20,10,0.55))',
    'border:1px solid rgba(255,225,106,0.55)',
    'box-shadow:0 0 14px rgba(255,225,106,0.25)',
  ].join(';');
  return panel;
}

export const resultsScene: Scene = {
  enter(sceneCtx: SceneContext): void {
    ensureBackground();

    const payload = sceneCtx.payload as ResultsPayload | undefined;
    if (!payload?.snapshot) {
      // No payload — bounce back.
      sceneCtx.navigate('songSelect');
      return;
    }
    payloadCache = payload;
    countUpStartMs = performance.now();

    const snap = payload.snapshot;
    const accuracy = computeAccuracy(snap);
    const stars = computeStars(accuracy);
    const difficulty: Difficulty = isDifficulty(payload.difficulty) ? payload.difficulty : 'medium';
    const difficultyLabel = DIFFICULTY_CONFIG[difficulty].label;
    const failed = payload.failed === true;

    scoreEl = el('div', { className: 'bh-results-score' }, ['0']);

    // A failed run never registers as a high score — preserves the tension
    // the rock meter is meant to add.
    const saveResult = failed
      ? { wasNew: false, previous: null }
      : saveIfBest(payload.songId, difficulty, {
          score: snap.score,
          accuracyPct: accuracy,
          stars,
          judgmentCounts: {
            perfect: snap.hits.perfect,
            great: snap.hits.great,
            good: snap.hits.good,
            miss: snap.hits.miss,
          },
        });

    const newBestBanner = saveResult.wasNew ? buildNewBestBanner() : null;
    const failedBanner = failed ? buildFailedBanner() : null;

    let bestLineText: string;
    if (saveResult.previous !== null) {
      bestLineText = formatPreviousBest(saveResult.previous);
    } else if (saveResult.wasNew) {
      bestLineText = 'First attempt — best saved!';
    } else {
      bestLineText = '';
    }
    const bestLine = bestLineText.length > 0 ? buildBestLine(bestLineText) : null;

    const replayPayload = { songId: payload.songId, difficulty };

    const playAgainBtn = el('button', { type: 'button', className: 'bh-btn bh-btn-primary' }, [
      'Play again',
    ]);
    playAgainBtn.addEventListener('click', () => {
      sceneCtx.navigate('play', replayPayload);
    });

    const songSelectBtn = el('button', { type: 'button', className: 'bh-btn' }, ['Song select']);
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
      ...(failedBanner ? [failedBanner] : []),
      ...(newBestBanner ? [newBestBanner] : []),
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
      ...(bestLine ? [bestLine] : []),
      el('div', { className: 'bh-results-actions' }, [songSelectBtn, playAgainBtn]),
    ]);

    // ---- Setlist mode ----------------------------------------------------
    // Distinct, separately-styled region appended below the high-scores UI
    // above. Updates cumulative score, then either auto-advances to the
    // next queued song or shows a "setlist complete" summary.
    advanceTriggered = false;
    countdownNext = null;
    countdownLineEl = null;
    recordResult(snap.score, stars);
    const next = peekNext();
    if (next !== null) {
      const advance = (): void => {
        const popped = popNext();
        const target = popped ?? next;
        sceneCtx.navigate('play', { songId: target.songId, difficulty: target.difficulty });
      };
      card.appendChild(buildSetlistPanel(next, advance, advance));
    } else {
      const cumulative = getCumulative();
      if (cumulative.songsPlayed >= 2) {
        card.appendChild(
          buildSetlistCompletePanel(
            {
              score: cumulative.score,
              stars: cumulative.stars,
              songsPlayed: cumulative.songsPlayed,
            },
            () => {
              resetCumulative();
              clearSetlist();
            },
          ),
        );
      }
    }

    root = el('div', { className: 'bh-results' }, [card]);
    sceneCtx.overlay.appendChild(root);

    onKeyDown = (ev: KeyboardEvent): void => {
      const target = ev.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      // While the auto-advance countdown is still running, ANY key press
      // cancels it (per the setlist spec) and consumes the event. The
      // player gets a chance to read their result before pressing Enter
      // again to actually advance.
      if (countdownIntervalId !== null && !advanceTriggered) {
        ev.preventDefault();
        cancelAutoAdvance();
        return;
      }
      switch (ev.code) {
        case 'Enter':
        case 'KeyF':
        case 'KeyJ':
          ev.preventDefault();
          // Once the countdown is cancelled (or never started), Enter
          // advances the setlist queue if a song is queued, otherwise it
          // falls back to the standard "play again" behaviour.
          if (countdownNext !== null && !advanceTriggered) {
            advanceTriggered = true;
            const popped = popNext();
            const target2 = popped ?? countdownNext;
            sceneCtx.navigate('play', {
              songId: target2.songId,
              difficulty: target2.difficulty,
            });
            return;
          }
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
    clearCountdownTimer();
    countdownLineEl = null;
    countdownNext = null;
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
