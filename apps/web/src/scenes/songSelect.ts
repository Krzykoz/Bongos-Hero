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
import { loadBest } from '../game/highScores.js';
import {
  addToSetlist,
  clearSetlist,
  getSetlist,
  removeFromSetlist,
  subscribe as subscribeSetlist,
  type SetlistEntry,
} from '../game/setlist.js';
import type { Scene, SceneContext } from '../router.js';
import { clear, el, fmtTime, fmtNumber } from './dom.js';
import { BackgroundRenderer } from '../render/background.js';

const STAGE_W = 1280;

let bg: BackgroundRenderer | null = null;
let root: HTMLDivElement | null = null;
let listEl: HTMLUListElement | null = null;
let footerEl: HTMLDivElement | null = null;
let difficultyEl: HTMLDivElement | null = null;
let setlistBadgeEl: HTMLButtonElement | null = null;
let setlistOverlay: HTMLDivElement | null = null;
let banner: HTMLDivElement | null = null;
let onKeyDown: ((ev: KeyboardEvent) => void) | null = null;
let activeSceneCtx: SceneContext | null = null;
let unsubscribeSetlist: (() => void) | null = null;

let songs: SongMeta[] = [];
let selectedIdx = 0;
let loaded = false;
let difficulty: Difficulty = 'medium';
let setlistEntries: SetlistEntry[] = [];

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
  if (difficulty === d) return;
  difficulty = d;
  saveDifficulty(d);
  renderDifficulty();
  // Badges below depend on the active difficulty — refresh them in place
  // (no scene re-enter, no scroll-jump, focus state preserved).
  if (activeSceneCtx) renderList(activeSceneCtx);
}

function isInSetlist(songId: string, diff: Difficulty): boolean {
  return setlistEntries.some((e) => e.songId === songId && e.difficulty === diff);
}

function buildSetlistButton(song: SongMeta): HTMLButtonElement {
  const inList = isInSetlist(song.id, difficulty);
  const label = inList ? '✓ Setlist' : '+ Setlist';
  const btn = el(
    'button',
    {
      type: 'button',
      className: inList ? 'bh-btn bh-setlist-btn bh-setlist-active' : 'bh-btn bh-setlist-btn',
      title: inList
        ? `Remove "${song.title}" (${DIFFICULTY_CONFIG[difficulty].label}) from setlist`
        : `Queue "${song.title}" (${DIFFICULTY_CONFIG[difficulty].label}) to setlist`,
    },
    [label],
  );
  btn.style.cssText = [
    'min-width:96px',
    'padding:6px 12px',
    'font:600 12px/1 "Segoe UI",system-ui,sans-serif',
    'letter-spacing:0.05em',
    'border-radius:8px',
    'border:1px solid rgba(196,121,255,0.55)',
    'background:rgba(40,18,60,0.55)',
    'color:#f5f0e3',
    'cursor:pointer',
    inList ? 'box-shadow:0 0 10px rgba(255,225,106,0.45)' : '',
    inList ? 'border-color:#ffe16a' : '',
    inList ? 'color:#ffe16a' : '',
  ]
    .filter((s) => s.length > 0)
    .join(';');
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const diff = difficulty;
    if (isInSetlist(song.id, diff)) removeFromSetlist(song.id, diff);
    else addToSetlist(song.id, diff);
  });
  return btn;
}

function buildSetlistBadge(): HTMLButtonElement {
  const btn = el('button', { type: 'button', className: 'bh-setlist-badge' }, [
    `Setlist (${setlistEntries.length})`,
  ]);
  btn.style.cssText = [
    'padding:6px 14px',
    'font:700 13px/1 "Segoe UI",system-ui,sans-serif',
    'letter-spacing:0.05em',
    'border-radius:999px',
    'border:1px solid rgba(255,225,106,0.55)',
    'background:linear-gradient(180deg,rgba(60,18,70,0.85),rgba(20,9,30,0.85))',
    'color:#ffe16a',
    'cursor:pointer',
    'box-shadow:0 0 10px rgba(255,225,106,0.25)',
    'pointer-events:auto',
  ].join(';');
  btn.title = 'Open setlist';
  btn.addEventListener('click', () => openSetlistOverlay());
  return btn;
}

function refreshSetlistBadge(): void {
  if (!setlistBadgeEl) return;
  setlistBadgeEl.textContent = `Setlist (${setlistEntries.length})`;
}

function songTitleFor(songId: string): string {
  const meta = songs.find((s) => s.id === songId);
  return meta?.title && meta.title.length > 0 ? meta.title : songId;
}

function closeSetlistOverlay(): void {
  if (setlistOverlay) {
    setlistOverlay.remove();
    setlistOverlay = null;
  }
}

function renderSetlistOverlayBody(body: HTMLDivElement): void {
  clear(body);
  if (setlistEntries.length === 0) {
    const empty = el('div', { className: 'bh-setlist-empty' }, [
      'No songs queued. Use the [+ Setlist] button on a row to add one.',
    ]);
    empty.style.cssText =
      'padding:24px 8px;color:rgba(245,240,227,0.7);text-align:center;font:400 14px/1.4 "Segoe UI",sans-serif';
    body.appendChild(empty);
    return;
  }
  const list = el('ol', { className: 'bh-setlist-list' });
  list.style.cssText = 'list-style:decimal;padding:0 0 0 28px;margin:0;color:#f5f0e3';
  setlistEntries.forEach((entry, i) => {
    const removeBtn = el('button', { type: 'button', className: 'bh-btn bh-btn-danger' }, ['×']);
    removeBtn.style.cssText =
      'padding:2px 10px;font:700 14px/1 "Segoe UI",sans-serif;border-radius:6px;cursor:pointer';
    removeBtn.title = 'Remove from setlist';
    removeBtn.addEventListener('click', () => {
      removeFromSetlist(entry.songId, entry.difficulty);
    });
    const row = el('li', { className: 'bh-setlist-item' }, [
      el('span', { className: 'bh-setlist-item-title' }, [songTitleFor(entry.songId)]),
      el('span', { className: 'bh-setlist-item-diff' }, [
        ` [${DIFFICULTY_CONFIG[entry.difficulty].label}]`,
      ]),
      removeBtn,
    ]);
    row.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:10px',
      'padding:8px 4px',
      'border-bottom:1px solid rgba(196,121,255,0.18)',
      i === setlistEntries.length - 1 ? 'border-bottom:none' : '',
    ]
      .filter((s) => s.length > 0)
      .join(';');
    const titleSpan = row.querySelector<HTMLSpanElement>('.bh-setlist-item-title');
    if (titleSpan) titleSpan.style.cssText = 'flex:1 1 auto;font-weight:600';
    const diffSpan = row.querySelector<HTMLSpanElement>('.bh-setlist-item-diff');
    if (diffSpan) diffSpan.style.cssText = 'color:rgba(245,240,227,0.6);font-size:12px';
    list.appendChild(row);
  });
  body.appendChild(list);
}

function openSetlistOverlay(): void {
  if (!activeSceneCtx) return;
  closeSetlistOverlay();

  const body = el('div', { className: 'bh-setlist-body' });
  body.style.cssText = 'flex:1 1 auto;overflow-y:auto;padding:8px 4px';
  renderSetlistOverlayBody(body);

  const closeBtn = el('button', { type: 'button', className: 'bh-btn' }, ['Close']);
  closeBtn.addEventListener('click', () => closeSetlistOverlay());

  const clearBtn = el('button', { type: 'button', className: 'bh-btn bh-btn-danger' }, [
    'Clear All',
  ]);
  clearBtn.addEventListener('click', () => {
    if (window.confirm('Clear the entire setlist? Cumulative score will reset too.')) {
      clearSetlist();
    }
  });

  const headerRow = el('div', { className: 'bh-setlist-overlay-header' }, [
    el('h3', {}, ['Setlist']),
    closeBtn,
  ]);
  headerRow.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px';

  const footerRow = el('div', { className: 'bh-setlist-overlay-footer' }, [clearBtn]);
  footerRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:8px';

  const card = el('div', { className: 'bh-setlist-overlay-card' }, [headerRow, body, footerRow]);
  card.style.cssText = [
    'position:relative',
    'width:min(560px,90vw)',
    'max-height:70vh',
    'display:flex',
    'flex-direction:column',
    'padding:18px 20px',
    'border-radius:14px',
    'background:linear-gradient(180deg,rgba(40,18,60,0.96),rgba(15,7,25,0.96))',
    'border:1px solid rgba(196,121,255,0.55)',
    'box-shadow:0 12px 36px rgba(0,0,0,0.65),0 0 28px rgba(196,121,255,0.35)',
    'color:#f5f0e3',
    'pointer-events:auto',
  ].join(';');

  const overlay = el('div', { className: 'bh-setlist-overlay' }, [card]);
  overlay.style.cssText = [
    'position:absolute',
    'inset:0',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'background:rgba(0,0,0,0.55)',
    'z-index:50',
    'pointer-events:auto',
  ].join(';');
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeSetlistOverlay();
  });

  setlistOverlay = overlay;
  activeSceneCtx.overlay.appendChild(overlay);
}

function refreshSetlistOverlayIfOpen(): void {
  if (!setlistOverlay) return;
  const body = setlistOverlay.querySelector<HTMLDivElement>('.bh-setlist-body');
  if (body) renderSetlistOverlayBody(body);
}

function buildBestBadge(songId: string): HTMLSpanElement {
  const best = loadBest(songId, difficulty);
  if (best === null) {
    const dash = el('span', { className: 'bh-song-best bh-song-best-empty' }, ['—']);
    dash.style.cssText = [
      'font:500 12px/1 "Segoe UI",system-ui,sans-serif',
      'color:rgba(245,240,227,0.3)',
      'min-width:64px',
      'text-align:right',
    ].join(';');
    return dash;
  }
  const badge = el('span', { className: 'bh-song-best' }, [`★ ${fmtNumber(best.score)}`]);
  badge.title = `Best on ${DIFFICULTY_CONFIG[difficulty].label}: ${best.stars}★, ${best.accuracyPct.toFixed(1)}%`;
  badge.style.cssText = [
    'font:700 13px/1 "Courier New",monospace',
    'color:#ffe16a',
    'text-shadow:0 0 8px rgba(255,225,106,0.45)',
    'letter-spacing:0.04em',
    'min-width:64px',
    'text-align:right',
  ].join(';');
  return badge;
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
  const hint = el('span', { className: 'bh-diff-hint' }, ['press 1 / 2 / 3 to change']);
  difficultyEl.appendChild(hint);
}

function renderList(sceneCtx: SceneContext): void {
  if (!listEl || !footerEl) return;
  clear(listEl);
  clear(footerEl);

  if (songs.length === 0) {
    const importNowBtn = el('button', { className: 'bh-btn bh-btn-primary', type: 'button' }, [
      'Import your first song',
    ]);
    importNowBtn.addEventListener('click', () => sceneCtx.navigate('import'));
    const empty = el('li', { className: 'bh-songselect-empty-cta' }, [
      el('h3', {}, ['No songs yet']),
      el('div', {}, ['Pull a track from YouTube to start playing — auto-charted in seconds.']),
      importNowBtn,
    ]);
    listEl.appendChild(empty);
  } else {
    if (selectedIdx >= songs.length) selectedIdx = songs.length - 1;
    if (selectedIdx < 0) selectedIdx = 0;

    songs.forEach((song, i) => {
      const isActive = i === selectedIdx;
      const titleRow = el('div', {}, [
        el('span', { className: 'bh-song-title' }, [song.title]),
        buildBestBadge(song.id),
      ]);
      titleRow.style.cssText = 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap';
      const titleSpan = el('div', {}, [
        titleRow,
        el('span', { className: 'bh-song-artist' }, [
          song.artist && song.artist.length > 0 ? song.artist : 'Unknown artist',
        ]),
      ]);
      const durationSpan = el('span', { className: 'bh-song-duration' }, [
        fmtTime(song.durationMs),
      ]);
      const setlistBtn = buildSetlistButton(song);
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
        [titleSpan, durationSpan, setlistBtn, deleteBtn],
      );
      row.style.gridTemplateColumns = '1fr auto auto auto';
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
      err instanceof ApiError ? `Delete failed: ${err.message}` : 'Delete failed (network error).',
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
    activeSceneCtx = sceneCtx;

    listEl = el('ul', { className: 'bh-songlist' });
    footerEl = el('div', { className: 'bh-songselect-footer' });
    difficultyEl = el('div', { className: 'bh-diff-picker' });
    setlistEntries = getSetlist();
    setlistBadgeEl = buildSetlistBadge();
    const headerLeft = el('div', { className: 'bh-songselect-header-left' }, [
      el('h2', {}, ['Choose your song']),
      el('span', { className: 'bh-songselect-help' }, ['↑↓ or W/S — Enter / F / J to play']),
    ]);
    headerLeft.style.cssText = 'display:flex;flex-direction:column;gap:4px';
    const header = el('div', { className: 'bh-songselect-header' }, [headerLeft, setlistBadgeEl]);

    root = el('div', { className: 'bh-songselect' }, [header, difficultyEl, listEl, footerEl]);
    sceneCtx.overlay.appendChild(root);
    renderDifficulty();

    unsubscribeSetlist = subscribeSetlist((state) => {
      setlistEntries = state.queue;
      refreshSetlistBadge();
      refreshSetlistOverlayIfOpen();
      if (loaded) renderList(sceneCtx);
    });

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
        case 'KeyR':
          ev.preventDefault();
          if (songs.length > 0) {
            const song = songs[selectedIdx];
            if (song) sceneCtx.navigate('rechart', { songId: song.id });
          }
          return;
        case 'KeyP':
          ev.preventDefault();
          if (songs.length > 0) {
            const song = songs[selectedIdx];
            if (song) sceneCtx.navigate('practice', { songId: song.id, difficulty });
          }
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
    if (unsubscribeSetlist) {
      unsubscribeSetlist();
      unsubscribeSetlist = null;
    }
    if (onKeyDown) {
      document.removeEventListener('keydown', onKeyDown);
      onKeyDown = null;
    }
    closeSetlistOverlay();
    if (root) {
      root.remove();
      root = null;
    }
    listEl = null;
    footerEl = null;
    difficultyEl = null;
    setlistBadgeEl = null;
    if (banner) {
      banner.remove();
      banner = null;
    }
    activeSceneCtx = null;
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
