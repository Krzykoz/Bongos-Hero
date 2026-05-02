/**
 * Import scene.
 *
 * Lets the player paste a YouTube URL, kicks off an import job, and polls
 * the job's status every ~600 ms until completion or failure.
 *
 * The KeyboardInput from the input/ layer is *not* attached during this
 * scene — F/J/Space/Esc must reach the URL `<input>` and our local
 * Esc-handler, not the game.
 */

import './scenes.css';
import type { JobState } from '@bongos-hero/shared';

import { ApiError, getJob, getSong, importSong } from '../api.js';
import type { Scene, SceneContext } from '../router.js';
import { el } from './dom.js';
import { BackgroundRenderer } from '../render/background.js';

const POLL_INTERVAL_MS = 600;

let bg: BackgroundRenderer | null = null;
let root: HTMLDivElement | null = null;
let urlInput: HTMLInputElement | null = null;
let submitBtn: HTMLButtonElement | null = null;
let cancelBtn: HTMLButtonElement | null = null;
let statusEl: HTMLDivElement | null = null;
let progressBar: HTMLDivElement | null = null;
let onKeyDown: ((ev: KeyboardEvent) => void) | null = null;

let pollTimer: number | null = null;
let activeJobId: string | null = null;
let navigateTimer: number | null = null;

function ensureBackground(): BackgroundRenderer {
  if (!bg) {
    bg = new BackgroundRenderer();
    bg.setBpm(120);
  }
  return bg;
}

function setStatus(msg: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  if (!statusEl) return;
  statusEl.className =
    kind === 'error'
      ? 'bh-import-status bh-error'
      : kind === 'success'
        ? 'bh-import-status bh-success'
        : 'bh-import-status';
  statusEl.textContent = msg;
}

function setProgress(p: number): void {
  if (!progressBar) return;
  const pct = Math.max(0, Math.min(1, p)) * 100;
  progressBar.style.width = `${pct.toFixed(1)}%`;
}

function statusLine(state: JobState): string {
  switch (state.status) {
    case 'queued':
      return 'Queued…';
    case 'downloading':
      return 'Downloading audio…';
    case 'transcoding':
      return 'Normalizing…';
    case 'charting':
      return 'Detecting onsets…';
    case 'done':
      return 'Done!';
    case 'error':
      return state.error ?? 'Import failed.';
  }
}

function clearTimers(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (navigateTimer !== null) {
    window.clearTimeout(navigateTimer);
    navigateTimer = null;
  }
}

function setBusy(busy: boolean): void {
  if (urlInput) urlInput.disabled = busy;
  if (submitBtn) {
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? 'Importing…' : 'Import';
  }
}

function resetForm(): void {
  clearTimers();
  activeJobId = null;
  setBusy(false);
  setProgress(0);
  if (urlInput) {
    urlInput.value = '';
    urlInput.focus();
  }
  setStatus('Paste a YouTube URL and press Import.', 'info');
}

async function pollOnce(sceneCtx: SceneContext): Promise<void> {
  if (!activeJobId) return;
  let state: JobState;
  try {
    state = await getJob(activeJobId);
  } catch (err) {
    console.error('[import] poll failed:', err);
    setStatus('Lost contact with server while polling.', 'error');
    setBusy(false);
    activeJobId = null;
    return;
  }

  setProgress(state.progress);
  setStatus(statusLine(state), state.status === 'error' ? 'error' : 'info');

  if (state.status === 'done') {
    activeJobId = null;
    setProgress(1);
    let title = 'song';
    if (state.songId) {
      try {
        const meta = await getSong(state.songId);
        title = meta.title;
      } catch {
        /* fallback to generic */
      }
    }
    setStatus(`Imported '${title}'`, 'success');
    navigateTimer = window.setTimeout(() => {
      sceneCtx.navigate('songSelect');
    }, 1000);
    return;
  }

  if (state.status === 'error') {
    activeJobId = null;
    setBusy(false);
    if (submitBtn) submitBtn.textContent = 'Try again';
    return;
  }

  pollTimer = window.setTimeout(() => {
    void pollOnce(sceneCtx);
  }, POLL_INTERVAL_MS);
}

async function onSubmit(sceneCtx: SceneContext): Promise<void> {
  const url = urlInput?.value.trim() ?? '';
  if (url.length === 0) {
    setStatus('Please paste a YouTube URL.', 'error');
    urlInput?.focus();
    return;
  }
  // Lightweight client-side sanity check; the server does the strict regex.
  if (!/^https?:\/\//i.test(url)) {
    setStatus('URL must start with http:// or https://', 'error');
    urlInput?.focus();
    return;
  }

  clearTimers();
  setBusy(true);
  setProgress(0);
  setStatus('Submitting…', 'info');

  let jobId: string;
  try {
    const res = await importSong(url);
    jobId = res.jobId;
  } catch (err) {
    console.error('[import] submit failed:', err);
    setBusy(false);
    if (submitBtn) submitBtn.textContent = 'Try again';
    if (err instanceof ApiError) {
      const body = err.body as { error?: string } | string | null;
      const detail =
        typeof body === 'object' && body !== null && typeof body.error === 'string'
          ? body.error
          : err.message;
      setStatus(detail, 'error');
    } else {
      setStatus('Import failed (network error).', 'error');
    }
    return;
  }

  activeJobId = jobId;
  await pollOnce(sceneCtx);
}

export const importScene: Scene = {
  enter(sceneCtx: SceneContext): void {
    ensureBackground();

    urlInput = el('input', {
      type: 'text',
      className: 'bh-import-input',
      placeholder: 'https://www.youtube.com/watch?v=...',
      autocomplete: 'off',
      spellcheck: false,
    });
    submitBtn = el(
      'button',
      { type: 'button', className: 'bh-btn bh-btn-primary' },
      ['Import'],
    );
    cancelBtn = el(
      'button',
      { type: 'button', className: 'bh-btn bh-btn-ghost' },
      ['Cancel'],
    );
    statusEl = el('div', { className: 'bh-import-status' }, [
      'Paste a YouTube URL and press Import.',
    ]);
    progressBar = el('div', { className: 'bh-progress-bar' });
    const progress = el('div', { className: 'bh-progress' }, [progressBar]);

    submitBtn.addEventListener('click', () => {
      void onSubmit(sceneCtx);
    });
    cancelBtn.addEventListener('click', () => {
      sceneCtx.navigate('songSelect');
    });
    urlInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void onSubmit(sceneCtx);
      }
    });

    const card = el('div', { className: 'bh-import-card' }, [
      el('h2', {}, ['Import from YouTube']),
      el('p', {}, [
        'Drop a YouTube URL — we download the audio, normalize it, and ' +
          'auto-chart bongo notes from the onsets.',
      ]),
      urlInput,
      progress,
      statusEl,
      el('div', { className: 'bh-import-actions' }, [cancelBtn, submitBtn]),
    ]);

    root = el('div', { className: 'bh-import-wrap' }, [card]);
    sceneCtx.overlay.appendChild(root);

    onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.code === 'Escape') {
        ev.preventDefault();
        sceneCtx.navigate('songSelect');
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // Defer focus until after the transition fade so the user sees the
    // caret appear in place.
    window.setTimeout(() => urlInput?.focus(), 0);
    void resetForm;
  },

  exit(sceneCtx: SceneContext): void {
    clearTimers();
    activeJobId = null;
    if (onKeyDown) {
      document.removeEventListener('keydown', onKeyDown);
      onKeyDown = null;
    }
    if (root) {
      root.remove();
      root = null;
    }
    urlInput = null;
    submitBtn = null;
    cancelBtn = null;
    statusEl = null;
    progressBar = null;
    void sceneCtx;
  },

  draw(sceneCtx: SceneContext, nowMs: number): void {
    ensureBackground().draw(sceneCtx.ctx, { nowMs });
  },
};
