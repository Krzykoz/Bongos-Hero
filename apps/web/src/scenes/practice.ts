/**
 * Practice scene.
 *
 * Lets the player loop a chosen section of a song at a reduced playback
 * rate (50% / 75% / 100%) so they can drill a hard passage. The actual
 * loop + rate enforcement is implemented in the AudioEngine
 * (`setLoopRange`, `setPlaybackRate`); this scene is just the picker UI
 * that hands the resulting `practice` payload to the play scene.
 *
 * Section data comes from `chart.sections` (auto-detected by the chart
 * pipeline). When a song was charted before sections existed, the scene
 * gracefully degrades to a "Full song" only option.
 *
 * Lifecycle:
 *   1. enter(): receives `{ songId, difficulty? }` payload, fetches the
 *      song's metadata + chart, builds the picker.
 *   2. Start → navigate('play', { songId, difficulty, practice: {...} }).
 *   3. Esc / Back → navigate('songSelect').
 */

import './scenes.css';
import './practice.css';
import {
  DIFFICULTY_CONFIG,
  isDifficulty,
  type ChartV1,
  type Difficulty,
  type SongMeta,
} from '@bongos-hero/shared';

import { ApiError, getSong, getSongChart } from '../api.js';
import { loadDifficulty } from '../game/difficulty.js';
import type { Scene, SceneContext } from '../router.js';
import { clear, el, fmtTime } from './dom.js';
import { BackgroundRenderer } from '../render/background.js';

const STAGE_W = 1280;

/** Selectable practice speeds, in display order. */
const PRACTICE_SPEEDS: readonly { rate: number; label: string }[] = [
  { rate: 0.5, label: '50%' },
  { rate: 0.75, label: '75%' },
  { rate: 1.0, label: '100%' },
];

/** Sentinel `endMs` value meaning "play the whole song without looping". */
const NO_LOOP = -1;

export interface PracticePayload {
  songId: string;
  difficulty?: Difficulty;
}

/**
 * Practice flags passed to the play scene via `navigate('play', { practice })`.
 * The play scene reads these in `enter()` and configures the AudioEngine
 * after the song has loaded.
 */
export interface PracticeFlags {
  /** Song-time loop range; `null` plays the full song. */
  loopRange: { startMs: number; endMs: number } | null;
  /** Initial playback rate (0.25..2.0). Matches AudioEngine.setPlaybackRate. */
  playbackRate: number;
}

interface SectionChoice {
  /** Index into `chart.sections` (0-based), or -1 for "full song". */
  index: number;
  startMs: number;
  endMs: number;
  label: string;
}

let bg: BackgroundRenderer | null = null;
let root: HTMLDivElement | null = null;
let banner: HTMLDivElement | null = null;
let onKeyDown: ((ev: KeyboardEvent) => void) | null = null;
let activeCtx: SceneContext | null = null;

let songId = '';
let difficulty: Difficulty = 'medium';
let sectionChoices: SectionChoice[] = [];
let selectedSectionIdx = 0; // index into `sectionChoices`
let selectedRate = 1.0;
let loaded = false;

function ensureBackground(): BackgroundRenderer {
  if (!bg) {
    bg = new BackgroundRenderer();
    bg.setBpm(120);
  }
  return bg;
}

function setBanner(overlay: HTMLDivElement, message: string | null): void {
  if (banner) {
    banner.remove();
    banner = null;
  }
  if (!message) return;
  banner = el('div', { className: 'bh-banner' }, [message]);
  overlay.appendChild(banner);
}

function buildSectionChoices(c: ChartV1 | null, songDurationMs: number): SectionChoice[] {
  const choices: SectionChoice[] = [
    {
      index: -1,
      startMs: 0,
      endMs: NO_LOOP,
      label: 'Full song',
    },
  ];
  const sections = c?.sections;
  if (!sections || sections.length === 0) {
    return choices;
  }
  sections.forEach((s, i) => {
    // Defensive: respect ChartSection invariants but never rely on `endMs`
    // exceeding `startMs` — drop a degenerate section instead of letting
    // `setLoopRange` reject it with a console warning.
    if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs)) return;
    if (s.endMs <= s.startMs) return;
    choices.push({
      index: i,
      startMs: Math.max(0, s.startMs),
      endMs: Math.min(s.endMs, songDurationMs > 0 ? songDurationMs : s.endMs),
      label: `Section ${i + 1}: ${fmtTime(s.startMs)} → ${fmtTime(s.endMs)}`,
    });
  });
  return choices;
}

function describeSection(c: SectionChoice): { idx: string; range: string; len: string } {
  if (c.index === -1) {
    return { idx: 'ALL', range: 'full song', len: '—' };
  }
  const lenMs = c.endMs - c.startMs;
  return {
    idx: `#${c.index + 1}`,
    range: `${fmtTime(c.startMs)} → ${fmtTime(c.endMs)}`,
    len: fmtTime(lenMs),
  };
}

function renderSections(parent: HTMLUListElement): void {
  clear(parent);
  sectionChoices.forEach((choice, i) => {
    const desc = describeSection(choice);
    const isActive = i === selectedSectionIdx;
    const btn = el(
      'button',
      {
        type: 'button',
        className: isActive ? 'bh-practice-section bh-active' : 'bh-practice-section',
        title: choice.label,
      },
      [
        el('span', { className: 'bh-practice-section-idx' }, [desc.idx]),
        el('span', { className: 'bh-practice-section-range' }, [desc.range]),
        el('span', { className: 'bh-practice-section-len' }, [desc.len]),
      ],
    );
    btn.addEventListener('click', () => {
      selectedSectionIdx = i;
      renderSections(parent);
    });
    btn.addEventListener('dblclick', () => {
      selectedSectionIdx = i;
      renderSections(parent);
      startPractice();
    });
    const li = el('li', {}, [btn]);
    li.style.cssText = 'list-style:none';
    parent.appendChild(li);
  });
}

function renderSpeeds(parent: HTMLDivElement): void {
  clear(parent);
  parent.appendChild(el('span', { className: 'bh-practice-speed-heading' }, ['Speed']));
  for (const spec of PRACTICE_SPEEDS) {
    const isActive = spec.rate === selectedRate;
    const btn = el(
      'button',
      {
        type: 'button',
        className: isActive ? 'bh-practice-speed bh-active' : 'bh-practice-speed',
        title: `Play at ${spec.label} of normal speed`,
      },
      [spec.label],
    );
    btn.addEventListener('click', () => {
      selectedRate = spec.rate;
      renderSpeeds(parent);
    });
    parent.appendChild(btn);
  }
}

function startPractice(): void {
  if (!activeCtx) return;
  const choice = sectionChoices[selectedSectionIdx];
  if (!choice) return;
  const loopRange =
    choice.endMs === NO_LOOP || choice.index === -1
      ? null
      : { startMs: choice.startMs, endMs: choice.endMs };
  const practice: PracticeFlags = {
    loopRange,
    playbackRate: selectedRate,
  };
  activeCtx.navigate('play', {
    songId,
    difficulty,
    practice,
  });
}

async function loadSongData(
  ctx: SceneContext,
): Promise<{ songMeta: SongMeta | null; chart: ChartV1 | null }> {
  let meta: SongMeta | null = null;
  let chartData: ChartV1 | null = null;
  try {
    meta = await getSong(songId);
  } catch (err) {
    console.warn('[practice] getSong failed (continuing):', err);
  }
  try {
    chartData = await getSongChart(songId);
  } catch (err) {
    console.error('[practice] getSongChart failed:', err);
    setBanner(
      ctx.overlay,
      err instanceof ApiError
        ? `Could not load chart: ${err.message}`
        : 'Could not load chart (network error).',
    );
  }
  const songDur = meta?.durationMs ?? 0;
  sectionChoices = buildSectionChoices(chartData, songDur);
  if (selectedSectionIdx >= sectionChoices.length) selectedSectionIdx = 0;
  loaded = true;
  return { songMeta: meta, chart: chartData };
}

export const practiceScene: Scene = {
  async enter(sceneCtx: SceneContext): Promise<void> {
    ensureBackground();
    activeCtx = sceneCtx;

    const payload = sceneCtx.payload as PracticePayload | undefined;
    songId = payload && typeof payload.songId === 'string' ? payload.songId : '';
    difficulty = isDifficulty(payload?.difficulty) ? payload.difficulty : loadDifficulty();

    // Reset picker state on every fresh entry.
    selectedSectionIdx = 0;
    selectedRate = 1.0;
    loaded = false;
    sectionChoices = [{ index: -1, startMs: 0, endMs: NO_LOOP, label: 'Full song' }];

    const titleText =
      payload && typeof payload.songId === 'string' ? `Practice: ${payload.songId}` : 'Practice';
    const headerLeft = el('div', { className: 'bh-practice-header-left' }, [
      el('h2', {}, [titleText]),
      el('span', { className: 'bh-practice-help' }, [
        '↑↓ section  •  1/2/3 speed  •  Enter to start  •  Esc to go back',
      ]),
    ]);
    headerLeft.style.cssText = 'display:flex;flex-direction:column;gap:4px';
    const header = el('div', { className: 'bh-practice-header' }, [headerLeft]);

    const sectionHeading = el('div', { className: 'bh-practice-section-heading' }, [
      'Choose a section to loop',
    ]);
    const sectionList = el('ul', { className: 'bh-practice-sections' });
    renderSections(sectionList);

    const speedRow = el('div', { className: 'bh-practice-speeds' });
    renderSpeeds(speedRow);

    const startBtn = el('button', { type: 'button', className: 'bh-btn bh-btn-primary' }, [
      'Start Practice',
    ]);
    startBtn.addEventListener('click', () => startPractice());

    const backBtn = el('button', { type: 'button', className: 'bh-btn bh-btn-ghost' }, ['Back']);
    backBtn.addEventListener('click', () => sceneCtx.navigate('songSelect'));

    const actions = el('div', { className: 'bh-practice-actions' }, [backBtn, startBtn]);

    root = el('div', { className: 'bh-practice' }, [
      header,
      sectionHeading,
      sectionList,
      speedRow,
      actions,
    ]);
    sceneCtx.overlay.appendChild(root);

    onKeyDown = (ev: KeyboardEvent): void => {
      const target = ev.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      switch (ev.code) {
        case 'ArrowUp':
        case 'KeyW':
          ev.preventDefault();
          if (sectionChoices.length > 0) {
            selectedSectionIdx =
              (selectedSectionIdx - 1 + sectionChoices.length) % sectionChoices.length;
            renderSections(sectionList);
          }
          return;
        case 'ArrowDown':
        case 'KeyS':
          ev.preventDefault();
          if (sectionChoices.length > 0) {
            selectedSectionIdx = (selectedSectionIdx + 1) % sectionChoices.length;
            renderSections(sectionList);
          }
          return;
        case 'Digit1':
          ev.preventDefault();
          selectedRate = 0.5;
          renderSpeeds(speedRow);
          return;
        case 'Digit2':
          ev.preventDefault();
          selectedRate = 0.75;
          renderSpeeds(speedRow);
          return;
        case 'Digit3':
          ev.preventDefault();
          selectedRate = 1.0;
          renderSpeeds(speedRow);
          return;
        case 'Enter':
          ev.preventDefault();
          startPractice();
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

    if (songId.length === 0) {
      setBanner(sceneCtx.overlay, 'No song was selected — go back and pick one.');
      return;
    }

    const { songMeta: loadedMeta } = await loadSongData(sceneCtx);
    if (activeCtx === sceneCtx) {
      // Re-render with real section data + a fresh title now that meta is known.
      const headerH2 = root?.querySelector<HTMLHeadingElement>('.bh-practice-header h2');
      if (headerH2) {
        const songLabel: string =
          loadedMeta !== null && loadedMeta.title.length > 0 ? loadedMeta.title : songId;
        headerH2.textContent = `Practice: ${songLabel}  •  ${DIFFICULTY_CONFIG[difficulty].label}`;
      }
      renderSections(sectionList);
    }
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
    if (banner) {
      banner.remove();
      banner = null;
    }
    activeCtx = null;
    void sceneCtx;
  },

  draw(sceneCtx: SceneContext, nowMs: number): void {
    const renderer = ensureBackground();
    renderer.draw(sceneCtx.ctx, { nowMs });

    if (!loaded) {
      sceneCtx.ctx.save();
      sceneCtx.ctx.fillStyle = 'rgba(245, 240, 227, 0.7)';
      sceneCtx.ctx.font = '600 18px "Segoe UI", sans-serif';
      sceneCtx.ctx.textAlign = 'center';
      sceneCtx.ctx.fillText('Loading practice…', STAGE_W / 2, 80);
      sceneCtx.ctx.restore();
    }
  },
};
