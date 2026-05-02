/**
 * Song select scene.
 *
 * Lists every song the backend knows about, lets the player navigate with
 * ↑/↓ (or W/S), confirm with Enter / F / J, delete a song, and jump to the
 * import scene to add a new one. A small difficulty picker (Easy / Medium /
 * Hard) lives at the top — its selection is persisted in localStorage and
 * threaded through the play and results scenes.
 *
 * Defensive: if `/api/songs` errors, we render a red banner explaining the
 * problem instead of crashing.
 */

import './scenes.css';
import {
  DIFFICULTY_CONFIG,
  DIFFICULTY_LIST,
  type Difficulty,
  type SongMeta,
} from '@bongos-hero/shared';

import { ApiError, deleteSong, listSongs } from '../api.js';
import { loadDifficulty, saveDifficulty } from '../game/difficulty.js';
import type { Scene, SceneContext } from '../router.js';
import { clear, el, fmtTime } from './dom.js';
import { BackgroundRenderer } from '../render/background.js';

const STAGE_W = 1280;

let bg: BackgroundRenderer | null = null;
let root: HTMLDivElement | null = null;
let listEl: HTMLUListElement | null = null;
let footerEl: HTMLDivElement | null = null;
let difficultyEl: HTMLDivElement | null = null;
let banner: HTMLDivElement | null = null;
let onKeyDown: ((ev: KeyboardEvent) => void) | null = null;

let songs: SongMeta[] = [];
let selectedIdx = 0;
let loaded = false;
let difficulty: Difficulty = 'medium';

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

function setDifficulty(d: Difficulty): void {
  difficulty = d;
  saveDifficulty(d);
  renderDifficulty();
}

function renderDifficulty(): void {
  if (!difficultyEl) return;
  clear(difficultyEl);
  const label = el('span', { className: 'bh-diff-label' }, ['Difficulty']);
  difficultyEl.appendChild(label);
  for (const d of DIFFICULTY_LIST) {
    const cfg = DIFFICULTY_CONFIG[d];
    const isActive = d === difficulty;
    const btn = el(
      'button',
      {
        type: 'button',
        className: isActive ? 'bh-diff-btn bh-active' : 'bh-diff-btn',
        title: `${cfg.label} — score ×${cfg.scoreMultiplier.toFixed(2)}`,
      },
      [cfg.label],
    );
    btn.addEventListener('click', () => setDifficulty(d));
    difficultyEl.appendChild(btn);
  }
  const hint = el('span', { className: 'bh-diff-hint' }, [
    'press 1 / 2 / 3 to change',
  ]);
  difficultyEl.appendChild(hint);
}

function renderList(sceneCtx: SceneContext): void {
  if (!listEl || !footerEl) return;
  clear(listEl);
  clear(footerEl);

  if (songs.length === 0) {
    const importNowBtn = el(
      'button',
      { className: 'bh-btn bh-btn-primary', type: 'button' },
      ['Import your first song'],
    );
    importNowBtn.addEventListener('click', () => sceneCtx.navigate('import'));
    const empty = el('li', { className: 'bh-songselect-empty-cta' }, [
      el('h3', {}, ['No songs yet']),
      el('div', {}, [
        'Pull a track from YouTube to start playing — auto-charted in seconds.',
      ]),
      importNowBtn,
    ]);
    listEl.appendChild(empty);
  } else {
    if (selectedIdx >= songs.length) selectedIdx = songs.length - 1;
    if (selectedIdx < 0) selectedIdx = 0;

    songs.forEach((song, i) => {
      const isActive = i === selectedIdx;
      const titleSpan = el('div', {}, [
        el('span', { className: 'bh-song-title' }, [song.title]),
        el('span', { className: 'bh-song-artist' }, [
          song.artist && song.artist.length > 0 ? song.artist : 'Unknown artist',
        ]),
      ]);
      const durationSpan = el('span', { className: 'bh-song-duration' }, [
        fmtTime(song.durationMs),
      ]);
      const deleteBtn = el(
        'button',
        {
          className: 'bh-btn bh-btn-danger',
          type: 'button',
          title: `Delete "${song.title}"`,
        },
        ['Delete'],
      );
      deleteBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void onDelete(sceneCtx, song);
      });

      const row = el(
        'li',
        {
          className: isActive ? 'bh-songrow bh-active' : 'bh-songrow',
        },
        [titleSpan, durationSpan, deleteBtn],
      );
      row.addEventListener('click', () => {
        selectedIdx = i;
        renderList(sceneCtx);
      });
      row.addEventListener('dblclick', () => {
        selectedIdx = i;
        startSelected(sceneCtx);
      });
      if (listEl) listEl.appendChild(row);
    });
  }

  const importBtn = el(
    'button',
    {
      className: 'bh-btn bh-btn-primary',
      type: 'button',
    },
    ['+ Import from YouTube'],
  );
  importBtn.addEventListener('click', () => sceneCtx.navigate('import'));
  footerEl.appendChild(importBtn);
}

function startSelected(sceneCtx: SceneContext): void {
  const song = songs[selectedIdx];
  if (!song) return;
  sceneCtx.navigate('play', { songId: song.id, difficulty });
}

async function onDelete(sceneCtx: SceneContext, song: SongMeta): Promise<void> {
  const ok = window.confirm(`Delete "${song.title}"? This cannot be undone.`);
  if (!ok) return;
  try {
    await deleteSong(song.id);
  } catch (err) {
    console.error('[songSelect] delete failed:', err);
    setBanner(
      sceneCtx.overlay,
      err instanceof ApiError
        ? `Delete failed: ${err.message}`
        : 'Delete failed (network error).',
    );
    return;
  }
  await refresh(sceneCtx);
}

async function refresh(sceneCtx: SceneContext): Promise<void> {
  try {
    songs = await listSongs();
    loaded = true;
    setBanner(sceneCtx.overlay, null);
  } catch (err) {
    console.error('[songSelect] listSongs failed:', err);
    songs = [];
    loaded = true;
    setBanner(
      sceneCtx.overlay,
      err instanceof ApiError && err.status === 0
        ? 'Cannot reach the Bongos Hero server. Is it running on :5174?'
        : 'Failed to load songs from the server.',
    );
  }
  renderList(sceneCtx);
}

export const songSelectScene: Scene = {
  async enter(sceneCtx: SceneContext): Promise<void> {
    ensureBackground();
    selectedIdx = 0;
    loaded = false;
    difficulty = loadDifficulty();

    listEl = el('ul', { className: 'bh-songlist' });
    footerEl = el('div', { className: 'bh-songselect-footer' });
    difficultyEl = el('div', { className: 'bh-diff-picker' });
    const header = el('div', { className: 'bh-songselect-header' }, [
      el('h2', {}, ['Choose your song']),
      el('span', { className: 'bh-songselect-help' }, [
        '↑↓ or W/S — Enter / F / J to play',
      ]),
    ]);

    root = el('div', { className: 'bh-songselect' }, [
      header,
      difficultyEl,
      listEl,
      footerEl,
    ]);
    sceneCtx.overlay.appendChild(root);
    renderDifficulty();

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
        case 'ArrowUp':
        case 'KeyW':
          ev.preventDefault();
          if (songs.length > 0) {
            selectedIdx = (selectedIdx - 1 + songs.length) % songs.length;
            renderList(sceneCtx);
          }
          return;
        case 'ArrowDown':
        case 'KeyS':
          ev.preventDefault();
          if (songs.length > 0) {
            selectedIdx = (selectedIdx + 1) % songs.length;
            renderList(sceneCtx);
          }
          return;
        case 'Enter':
        case 'KeyF':
        case 'KeyJ':
          ev.preventDefault();
          startSelected(sceneCtx);
          return;
        case 'Digit1':
          ev.preventDefault();
          setDifficulty('easy');
          return;
        case 'Digit2':
          ev.preventDefault();
          setDifficulty('medium');
          return;
        case 'Digit3':
          ev.preventDefault();
          setDifficulty('hard');
          return;
        case 'Escape':
          ev.preventDefault();
          sceneCtx.navigate('title');
          return;
        default:
          return;
      }
    };
    document.addEventListener('keydown', onKeyDown);

    await refresh(sceneCtx);
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
    listEl = null;
    footerEl = null;
    difficultyEl = null;
    if (banner) {
      banner.remove();
      banner = null;
    }
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
      sceneCtx.ctx.fillText('Loading songs…', STAGE_W / 2, 80);
      sceneCtx.ctx.restore();
    }
  },
};
