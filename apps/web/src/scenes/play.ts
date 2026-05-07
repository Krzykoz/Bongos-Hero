/**
 * Play scene — the actual game loop.
 *
 * Owns the AudioEngine (master clock), KeyboardInput, ScoringEngine, and
 * the full renderer stack (background → highway → notes → effects → HUD).
 *
 * Lifecycle:
 *   1. enter(): load chart + audio, build engines, subscribe events, run a
 *      3-second count-in driven by performance.now() (audio is paused and
 *      currentTimeMs() is synthesised as -3000…0 during the count-in).
 *   2. draw(): pull `nowMs` from `audio.currentTimeMs()` (or the count-in
 *      synth clock), tick scoring, draw layers in order, then HUD.
 *   3. Pause / quit / end-of-song are handled inline.
 *   4. exit(): detach inputs, stop audio, remove every DOM overlay this
 *      scene created.
 */

import './scenes.css';
import {
  DIFFICULTY_CONFIG,
  isDifficulty,
  type ChartV1,
  type Difficulty,
  type SongMeta,
} from '@bongos-hero/shared';

import { AudioEngine } from '../audio/engine.js';
import { loadAudioOffsetMs } from '../audio/latency.js';
import { buildSfxBank, type SfxBank } from '../audio/sfxBank.js';
import { ScoringEngine, type ScoringEvent } from '../game/scoring.js';
import { type PreparedChart, prepareChart } from '../game/chart.js';
import { loadDifficulty } from '../game/difficulty.js';
import { KeyboardInput, type InputEvent } from '../input/keyboard.js';
import { HighwayRenderer } from '../render/highway.js';
import { NotesRenderer } from '../render/notes.js';
import { BongosRenderer } from '../render/bongos.js';

import { ApiError, getSong, getSongChart, songAudioUrl } from '../api.js';
import type { Scene, SceneContext } from '../router.js';
import { el } from './dom.js';
import { BackgroundRenderer } from '../render/background.js';
import { EffectsRenderer } from '../render/effects.js';
import { HudRenderer } from '../render/hud.js';
import { extractYouTubeId, YouTubeBackground } from '../youtube/embed.js';

const COUNT_IN_MS = 3000;
const COMBO_POPUP_THRESHOLD = 50;
const STAGE_W = 1280;
const STAGE_H = 720;
const YT_DRIFT_INTERVAL_MS = 1000;

interface PlayPayload {
  songId: string;
  difficulty?: Difficulty;
}

type Phase = 'loading' | 'countin' | 'playing' | 'paused' | 'ended' | 'error';

interface PlayState {
  phase: Phase;
  songId: string;
  difficulty: Difficulty;
  songMeta: SongMeta | null;
  prepared: PreparedChart | null;
  audio: AudioEngine | null;
  sfx: SfxBank | null;
  input: KeyboardInput | null;
  scoring: ScoringEngine | null;
  background: BackgroundRenderer;
  highway: HighwayRenderer;
  notes: NotesRenderer;
  effects: EffectsRenderer;
  hud: HudRenderer;
  bongos: BongosRenderer;
  youtube: YouTubeBackground | null;
  /** Wall-clock ms of the last YT drift correction tick. */
  ytLastDriftMs: number;
  unsubscribers: (() => void)[];
  /** performance.now() at the start of the count-in. */
  countInStartedAtPerf: number;
  /** Monotonic combo at the last frame, used to detect milestone crossings. */
  lastCombo: number;
  /** True once we've handed off to the results scene. */
  ended: boolean;
}

let state: PlayState | null = null;
let overlayRoot: HTMLDivElement | null = null;
let pauseOverlay: HTMLDivElement | null = null;
let onKeyDown: ((ev: KeyboardEvent) => void) | null = null;

function makeInitialState(songId: string, difficulty: Difficulty): PlayState {
  return {
    phase: 'loading',
    songId,
    difficulty,
    songMeta: null,
    prepared: null,
    audio: null,
    sfx: null,
    input: null,
    scoring: null,
    background: new BackgroundRenderer(),
    highway: new HighwayRenderer(),
    notes: new NotesRenderer(),
    effects: new EffectsRenderer(),
    hud: new HudRenderer(),
    bongos: new BongosRenderer(),
    youtube: null,
    ytLastDriftMs: 0,
    unsubscribers: [],
    countInStartedAtPerf: 0,
    lastCombo: 0,
    ended: false,
  };
}

function showLoadingOverlay(sceneCtx: SceneContext, message: string): void {
  removeOverlayRoot();
  overlayRoot = el('div', { className: 'bh-overlay-center' }, [
    el('div', { className: 'bh-overlay-card' }, [
      el('h3', {}, ['Loading…']),
      el('p', {}, [message]),
    ]),
  ]);
  sceneCtx.overlay.appendChild(overlayRoot);
}

function showErrorOverlay(sceneCtx: SceneContext, title: string, message: string): void {
  removeOverlayRoot();
  const backBtn = el('button', { className: 'bh-btn bh-btn-primary', type: 'button' }, ['Back']);
  backBtn.addEventListener('click', () => sceneCtx.navigate('songSelect'));
  overlayRoot = el('div', { className: 'bh-overlay-center' }, [
    el('div', { className: 'bh-overlay-card bh-error' }, [
      el('h3', {}, [title]),
      el('p', {}, [message]),
      el('div', { className: 'bh-import-actions' }, [backBtn]),
    ]),
  ]);
  sceneCtx.overlay.appendChild(overlayRoot);
}

function removeOverlayRoot(): void {
  if (overlayRoot) {
    overlayRoot.remove();
    overlayRoot = null;
  }
}

function showPauseOverlay(sceneCtx: SceneContext): void {
  removePauseOverlay();
  pauseOverlay = el('div', { className: 'bh-pause' }, [
    'PAUSED',
    el('span', { className: 'bh-pause-hint' }, ['press ESC to resume — Q to quit']),
  ]);
  sceneCtx.overlay.appendChild(pauseOverlay);
}

function removePauseOverlay(): void {
  if (pauseOverlay) {
    pauseOverlay.remove();
    pauseOverlay = null;
  }
}

function getMasterClockMs(s: PlayState): number {
  if (s.phase === 'countin') {
    const elapsed = performance.now() - s.countInStartedAtPerf;
    return Math.min(0, elapsed - COUNT_IN_MS);
  }
  if (s.audio) return s.audio.currentTimeMs();
  return 0;
}

function handleScoringEvent(s: PlayState, ev: ScoringEvent): void {
  switch (ev.type) {
    case 'judgment':
      if (ev.judgment === 'miss') {
        if (ev.lane) s.effects.spawnMiss(ev.lane, ev.tMs);
        s.sfx?.engine.play('miss', { gain: 0.5 });
      } else if (ev.judgment !== undefined && ev.lane !== undefined) {
        s.effects.spawnHit(ev.lane, ev.judgment, ev.tMs);
        s.bongos.noteHit(ev.lane, ev.judgment, ev.tMs);
        if (ev.judgment === 'perfect') s.sfx?.engine.play('hit-perfect', { gain: 0.6 });
        else if (ev.judgment === 'great') s.sfx?.engine.play('hit-great', { gain: 0.5 });
        else if (ev.judgment === 'good') s.sfx?.engine.play('hit-good', { gain: 0.4 });
      }
      // Combo milestone popup (50, 100, 150, ...).
      if (s.scoring) {
        const combo = s.scoring.snapshot().combo;
        if (
          combo >= COMBO_POPUP_THRESHOLD &&
          combo % COMBO_POPUP_THRESHOLD === 0 &&
          combo !== s.lastCombo
        ) {
          s.effects.spawnComboPopup(combo, ev.tMs);
        }
        s.lastCombo = combo;
      }
      return;
    case 'sp-activated':
      s.effects.spawnStarPowerActivated(ev.tMs);
      s.sfx?.engine.play('sp-activate', { gain: 0.7 });
      return;
    case 'stray':
      // Stray press also breaks combo; render no extra effect for now.
      return;
    case 'sp-depleted':
    case 'phrase-complete':
      return;
  }
}

function handleInputEvent(s: PlayState, ev: InputEvent): void {
  if (s.phase !== 'playing') return;
  if (ev.type === 'bongo') {
    s.scoring?.pressBongo(ev.lane, ev.tMs);
  } else if (ev.action === 'starpower') {
    s.scoring?.activateStarPower(ev.tMs);
  } else if (ev.action === 'pause') {
    pauseGame(s);
  }
}

function pauseGame(s: PlayState): void {
  if (s.phase !== 'playing') return;
  s.audio?.pause();
  s.youtube?.pause();
  s.phase = 'paused';
  if (currentSceneCtx) showPauseOverlay(currentSceneCtx);
}

function resumeGame(s: PlayState): void {
  if (s.phase !== 'paused') return;
  removePauseOverlay();
  s.phase = 'playing';
  void s.audio?.resume();
  if (s.audio && s.youtube) s.youtube.resume(s.audio.currentTimeMs());
}

function quitToSongSelect(sceneCtx: SceneContext, s: PlayState): void {
  s.audio?.stop();
  s.youtube?.stop();
  s.input?.detach();
  sceneCtx.navigate('songSelect');
}

/**
 * The router only hands the scene a fresh SceneContext on each draw call,
 * but pause/quit triggered by KeyboardInput events have to navigate without
 * one. We cache the most recent SceneContext seen by `draw` so action
 * handlers can use it.
 */
let currentSceneCtx: SceneContext | null = null;

async function startCountIn(s: PlayState): Promise<void> {
  s.phase = 'countin';
  s.countInStartedAtPerf = performance.now();
  // Schedule audio play after the count-in.
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, COUNT_IN_MS);
  });
  if (state !== s) return; // scene was exited
  if (!s.audio) return;
  // 0-note charts: nothing meaningful to play, but we still play audio so
  // the user hears the song; the renderers handle empty visible ranges.
  try {
    await s.audio.play(0);
  } catch (err) {
    console.error('[play] audio.play threw:', err);
    if (currentSceneCtx) {
      showErrorOverlay(
        currentSceneCtx,
        'Playback failed',
        err instanceof Error ? err.message : 'Unknown audio error.',
      );
      s.phase = 'error';
    }
    return;
  }
  s.phase = 'playing';
  // Start the YouTube background in lockstep with the local audio so they
  // play together. The iframe is muted; the local engine is the audio.
  if (s.youtube && s.audio) {
    s.youtube.start(s.audio.currentTimeMs());
  }
  s.input?.attach();
}

/**
 * Try to mount a YouTube background for the currently-loading song. Best
 * effort: any failure (no YouTube ID in `sourceUrl`, network error, age
 * gate, blocked CDN) is swallowed and `s.youtube` stays null, in which
 * case the play scene paints its normal opaque animated background.
 */
async function tryMountYouTube(
  s: PlayState,
  songMeta: SongMeta,
  audioOffsetMs: number,
): Promise<void> {
  const id = extractYouTubeId(songMeta.sourceUrl);
  if (!id) return;
  const container = document.getElementById('yt-bg');
  if (!container) return;
  container.classList.add('bh-yt-active');
  const yt = new YouTubeBackground({
    container,
    videoId: id,
    audioOffsetMs,
  });
  try {
    await yt.load();
  } catch (err) {
    console.warn('[play] YouTube background failed; falling back to opaque bg:', err);
    yt.dispose();
    container.classList.remove('bh-yt-active');
    return;
  }
  if (state !== s) {
    // Scene exited while we were loading.
    yt.dispose();
    container.classList.remove('bh-yt-active');
    return;
  }
  s.youtube = yt;
}

function disposeYouTube(s: PlayState): void {
  if (!s.youtube) return;
  s.youtube.dispose();
  s.youtube = null;
  const container = document.getElementById('yt-bg');
  if (container) container.classList.remove('bh-yt-active');
}

export const playScene: Scene = {
  async enter(sceneCtx: SceneContext): Promise<void> {
    currentSceneCtx = sceneCtx;

    const payload = sceneCtx.payload as PlayPayload | undefined;
    if (!payload || typeof payload.songId !== 'string') {
      showErrorOverlay(sceneCtx, 'Missing song', 'No songId was provided to the play scene.');
      return;
    }

    const difficulty: Difficulty = isDifficulty(payload.difficulty)
      ? payload.difficulty
      : loadDifficulty();

    const s = makeInitialState(payload.songId, difficulty);
    state = s;

    showLoadingOverlay(sceneCtx, 'Fetching chart and audio…');

    // Load metadata (best effort — for the HUD song title).
    try {
      s.songMeta = await getSong(payload.songId);
    } catch (err) {
      console.warn('[play] getSong failed (continuing):', err);
    }

    let chart: ChartV1;
    try {
      chart = await getSongChart(payload.songId);
    } catch (err) {
      console.error('[play] getSongChart failed:', err);
      showErrorOverlay(
        sceneCtx,
        'Could not load chart',
        err instanceof ApiError ? `${err.message}` : 'Network error while fetching the chart.',
      );
      s.phase = 'error';
      return;
    }

    // Build audio engine with persisted calibration offset baked in.
    const audioOffsetMs = loadAudioOffsetMs();
    const audio = new AudioEngine({ audioOffsetMs });
    s.audio = audio;
    try {
      await audio.load(songAudioUrl(payload.songId));
    } catch (err) {
      console.error('[play] audio.load failed:', err);
      showErrorOverlay(
        sceneCtx,
        'Could not load audio',
        err instanceof Error ? err.message : 'Unknown audio error.',
      );
      s.phase = 'error';
      return;
    }

    // Mount the YouTube background in parallel with the rest of setup. We
    // do not await this — it can take a few seconds and we don't want to
    // block the count-in. shouldShow() stays false until the player is
    // confirmed playing, so the canvas keeps its opaque bg until then.
    if (s.songMeta) {
      void tryMountYouTube(s, s.songMeta, audioOffsetMs);
    }

    // SFX bank (best-effort: silent fall-back if synthesis fails).
    try {
      s.sfx = await buildSfxBank(audio.ctx);
      s.sfx.engine.setMasterVolume(0.7);
    } catch (err) {
      console.warn('[play] buildSfxBank failed (continuing without SFX):', err);
    }

    s.prepared = prepareChart(chart, s.difficulty);
    s.notes.setChart(s.prepared.playableChart);
    s.background.setBpm(chart.bpm ?? 120);

    s.scoring = new ScoringEngine(s.prepared);
    s.unsubscribers.push(
      s.scoring.on((ev) => {
        if (state === s) handleScoringEvent(s, ev);
      }),
    );

    // Audio end-of-song → results.
    s.unsubscribers.push(
      audio.onEnded(() => {
        if (state !== s) return;
        if (s.ended) return;
        s.ended = true;
        s.phase = 'ended';
        const snapshot = s.scoring?.snapshot();
        if (currentSceneCtx && snapshot && s.songMeta) {
          currentSceneCtx.navigate('results', {
            songMeta: s.songMeta,
            snapshot,
            songId: s.songId,
            difficulty: s.difficulty,
          });
        } else if (currentSceneCtx) {
          // No songMeta? Still navigate so the player isn't stuck.
          currentSceneCtx.navigate('songSelect');
        }
      }),
    );

    // Input — wired to read the master clock so stray events get a current
    // tMs even if the audio engine is paused (returns last known time).
    const input = new KeyboardInput({
      getSongTimeMs: () => getMasterClockMs(s),
    });
    s.input = input;
    s.unsubscribers.push(input.on((ev) => handleInputEvent(s, ev)));

    // Local document-level keydown for pause-overlay actions and a fallback
    // for Escape during count-in.
    onKeyDown = (ev: KeyboardEvent): void => {
      const target = ev.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (s.phase === 'paused') {
        if (ev.code === 'Escape') {
          ev.preventDefault();
          resumeGame(s);
        } else if (ev.code === 'KeyQ') {
          ev.preventDefault();
          if (currentSceneCtx) quitToSongSelect(currentSceneCtx, s);
        }
        return;
      }
      // During count-in, Escape returns to song select.
      if (s.phase === 'countin' && ev.code === 'Escape') {
        ev.preventDefault();
        if (currentSceneCtx) quitToSongSelect(currentSceneCtx, s);
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // 0-note edge case: skip play, fall straight through to results with
    // an empty snapshot.
    if (s.prepared.totalNotes === 0) {
      removeOverlayRoot();
      const snapshot = s.scoring.snapshot();
      s.ended = true;
      s.phase = 'ended';
      sceneCtx.navigate('results', {
        songMeta: s.songMeta,
        snapshot,
        songId: s.songId,
        difficulty: s.difficulty,
      });
      return;
    }

    removeOverlayRoot();
    void startCountIn(s);
  },

  exit(sceneCtx: SceneContext): void {
    if (onKeyDown) {
      document.removeEventListener('keydown', onKeyDown);
      onKeyDown = null;
    }
    removePauseOverlay();
    removeOverlayRoot();
    if (state) {
      for (const un of state.unsubscribers) {
        try {
          un();
        } catch {
          /* ignore */
        }
      }
      state.unsubscribers.length = 0;
      state.input?.detach();
      state.audio?.stop();
      disposeYouTube(state);
      state = null;
    }
    currentSceneCtx = null;
    void sceneCtx;
  },

  draw(sceneCtx: SceneContext, nowFramePerfMs: number): void {
    currentSceneCtx = sceneCtx;
    const s = state;
    if (!s) return;

    const ctx = sceneCtx.ctx;
    const ytShowing = s.youtube?.shouldShow() === true;

    // Always start each frame with a clean canvas. The animated background
    // path also paints the full sky/highway-bg, so without this clear we'd
    // be relying on those paints to mask the previous frame; doing it
    // explicitly here means the YT-transparent path "just works" with no
    // ghost trails.
    ctx.clearRect(0, 0, STAGE_W, STAGE_H);

    if (s.phase === 'error') {
      // Still paint the background so the screen isn't black behind the card.
      if (!ytShowing) s.background.draw(ctx, { nowMs: nowFramePerfMs });
      return;
    }
    if (s.phase === 'loading') {
      if (!ytShowing) s.background.draw(ctx, { nowMs: nowFramePerfMs });
      return;
    }

    const nowMs = getMasterClockMs(s);
    s.scoring?.tick(nowMs);
    const snapshot = s.scoring?.snapshot();

    const sp = snapshot?.spActive === true;
    const beatPhase = s.background.beatPhase(nowMs);

    // Periodic YouTube drift correction (1 Hz, only while audio is playing
    // and the iframe is showing).
    if (
      ytShowing &&
      s.youtube &&
      s.audio &&
      s.phase === 'playing' &&
      nowFramePerfMs - s.ytLastDriftMs > YT_DRIFT_INTERVAL_MS
    ) {
      s.youtube.driftCorrect(s.audio.currentTimeMs());
      s.ytLastDriftMs = nowFramePerfMs;
    }

    // 1. Background — only when the YouTube video is NOT taking over the
    //    backdrop. Skipping the entire BackgroundRenderer (rather than
    //    making it transparent) keeps the dark band/crowd silhouettes from
    //    fighting bright frames in the music video.
    if (!ytShowing) {
      s.background.draw(ctx, {
        nowMs,
        beatPhase,
        starPowerActive: sp,
      });
    }

    // 2. Save + apply screen shake.
    const shake = s.effects.shakeOffset(nowMs);
    ctx.save();
    if (shake.x !== 0 || shake.y !== 0) {
      ctx.translate(shake.x, shake.y);
    }

    // 3. Highway. When YT is showing, the highway skips its full-stage bg
    //    fill so the iframe shows through outside the trapezoid.
    s.highway.draw(ctx, {
      pressed: {
        L: s.input?.isLanePressed('L') ?? false,
        R: s.input?.isLanePressed('R') ?? false,
      },
      starPowerActive: sp,
      beatPulse: 1 - beatPhase,
      transparentBackground: ytShowing,
    });

    // 4. Notes.
    if (snapshot) {
      s.notes.draw(ctx, {
        nowMs,
        starPowerActive: sp,
        hitNoteIndexes: snapshot.consumed,
      });
    } else {
      s.notes.draw(ctx, { nowMs, starPowerActive: sp });
    }

    // 5. Effects.
    s.effects.draw(ctx, { nowMs });

    // 6. Bongos at the bottom of the stage.
    s.bongos.draw(ctx, {
      nowMs,
      pressed: {
        L: s.input?.isLanePressed('L') ?? false,
        R: s.input?.isLanePressed('R') ?? false,
      },
    });

    // 7. Restore (un-shake).
    ctx.restore();

    // 8. HUD.
    if (snapshot && s.audio) {
      const titleWithDifficulty = s.songMeta?.title
        ? `${s.songMeta.title}  •  ${DIFFICULTY_CONFIG[s.difficulty].label}`
        : DIFFICULTY_CONFIG[s.difficulty].label;
      s.hud.draw(ctx, {
        snapshot,
        songTimeMs: Math.max(0, nowMs),
        songDurationMs: s.audio.durationMs,
        pressedL: s.input?.isLanePressed('L') ?? false,
        pressedR: s.input?.isLanePressed('R') ?? false,
        songTitle: titleWithDifficulty,
        // Bongos already act as the lane-press indicator.
        hideKeyCaps: true,
      });
    }

    // 9. Count-in overlay (drawn directly on canvas, above everything).
    if (s.phase === 'countin') {
      drawCountIn(ctx, nowMs);
    }
  },
};

function drawCountIn(ctx: CanvasRenderingContext2D, nowMs: number): void {
  // nowMs in [-3000, 0]; map to a 3..2..1..GO label.
  const remainingMs = -nowMs;
  if (remainingMs < 0) return;
  let label = 'GO';
  if (remainingMs > 2000) label = '3';
  else if (remainingMs > 1000) label = '2';
  else if (remainingMs > 0) label = '1';

  const segMs = remainingMs % 1000;
  const segPhase = 1 - segMs / 1000;
  const alpha = 0.4 + 0.6 * segPhase;
  const scale = 1 + 0.6 * (1 - segPhase);

  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#f0e6ff';
  ctx.font = `bold ${Math.round(220 * scale)}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(196, 121, 255, 0.7)';
  ctx.shadowBlur = 36;
  ctx.fillText(label, STAGE_W / 2, STAGE_H / 2);
  ctx.shadowBlur = 0;
  ctx.restore();
}
