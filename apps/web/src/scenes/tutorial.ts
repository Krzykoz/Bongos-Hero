/**
 * Tutorial scene — first-run, ~30-second guided onboarding.
 *
 * Plays the hand-authored `tutorialChart` (no audio source) against a
 * `performance.now()`-derived clock. Wires the same `KeyboardInput` +
 * `ScoringEngine` + renderer stack the live play scene uses, so the player
 * actually hits notes and feels the highway / hit effects / SP meter — but
 * without ever loading audio, persisting a score, navigating to results, or
 * failing out (rock-meter `'fail'` events are intentionally ignored).
 *
 * Lifecycle:
 *   1. enter(): set up engines + renderers, attach input, start the scene
 *      clock from `performance.now()`. The first overlay step (welcome) is
 *      mounted immediately.
 *   2. draw(): each frame, compute `t = perf.now() - startedAtPerf`, advance
 *      the scoring engine, swap the overlay text for whatever step `t`
 *      falls into, and paint the same render layers as the play scene.
 *   3. Esc OR `t >= TUTORIAL_DURATION_MS`: flip `tutorialSeen=true` in
 *      settings and navigate back to title.
 *
 * Audio approach: there is no AudioEngine here. The chart timeline runs
 * against `performance.now()` directly because the tutorial is short and
 * the engine's `load(url)` API requires a fetchable audio file — adding a
 * silent-buffer code path to the engine just for this scene would touch a
 * file outside this todo's ownership. The trade-off is that the tutorial
 * pause / count-in / loop-range features are not available, which is fine
 * because the tutorial is a fixed-length linear walkthrough.
 */

import './scenes.css';

import { ScoringEngine, type ScoringEvent } from '../game/scoring.js';
import { prepareChart, type PreparedChart } from '../game/chart.js';
import { KeyboardInput, type InputEvent } from '../input/keyboard.js';
import { laneForCode } from '../input/sides.js';
import { BackgroundRenderer } from '../render/background.js';
import { HighwayRenderer } from '../render/highway.js';
import { NotesRenderer } from '../render/notes.js';
import { EffectsRenderer } from '../render/effects.js';
import { HudRenderer } from '../render/hud.js';
import { BongosRenderer } from '../render/bongos.js';
import { saveSettings } from '../settings/index.js';
import type { Scene, SceneContext } from '../router.js';
import { el } from './dom.js';
import { tutorialChart } from './tutorialChart.js';

const STAGE_W = 1280;
const STAGE_H = 720;

/** Tutorial wraps up at exactly this t (ms) regardless of player progress. */
const TUTORIAL_DURATION_MS = 33_000;

interface Step {
  /** Scene-clock ms when this overlay text should become visible. */
  startMs: number;
  /** Scene-clock ms when it should yield to the next step. */
  endMs: number;
  text: string;
}

/**
 * Step timeline. Adjacent ranges abut (`endMs` of N === `startMs` of N+1) so
 * `pickStep` always finds exactly one match. The wording uses the actual
 * default keys (`F` left, `J` right, `SPACE` star power, `ESC` pause) — these
 * are static; if a user has rebound them, the tutorial still shows the
 * defaults because it's the simplest mental model for first-run.
 */
const STEPS: readonly Step[] = [
  {
    startMs: 0,
    endMs: 3000,
    text: 'Welcome! F hits the LEFT bongo. J hits the RIGHT bongo.',
  },
  {
    startMs: 3000,
    endMs: 10_000,
    text: 'Smash F or J as the notes cross the line at the bottom.',
  },
  {
    startMs: 10_000,
    endMs: 14_000,
    text: 'Long notes are coming — hold the key while the bar streams down.',
  },
  {
    startMs: 14_000,
    endMs: 20_000,
    text: 'Hold until the trail fades, then release.',
  },
  {
    startMs: 20_000,
    endMs: 23_000,
    text: 'Star Power notes glow. Fill the meter, then press SPACE to double your score.',
  },
  {
    startMs: 23_000,
    endMs: 30_000,
    text: 'Land the glowing notes cleanly — once the meter hits half, mash SPACE!',
  },
  {
    startMs: 30_000,
    endMs: TUTORIAL_DURATION_MS,
    text: 'Press ESC anytime to pause. You’re ready — see you on the highway!',
  },
];

interface State {
  prepared: PreparedChart;
  scoring: ScoringEngine;
  input: KeyboardInput;
  background: BackgroundRenderer;
  highway: HighwayRenderer;
  notes: NotesRenderer;
  effects: EffectsRenderer;
  hud: HudRenderer;
  bongos: BongosRenderer;
  unsubscribers: (() => void)[];
  /** `performance.now()` snapshotted on `enter()`. */
  startedAtPerfMs: number;
  /** Latched true the first time we navigate away. */
  exited: boolean;
  /** Index into `STEPS` of the banner currently mounted; -1 before mount. */
  shownStepIdx: number;
}

let state: State | null = null;
let currentSceneCtx: SceneContext | null = null;
let stepBanner: HTMLDivElement | null = null;
let badge: HTMLDivElement | null = null;
let onKeyDown: ((ev: KeyboardEvent) => void) | null = null;
let onKeyUp: ((ev: KeyboardEvent) => void) | null = null;
let onWindowBlur: ((ev: FocusEvent) => void) | null = null;

function getMasterClockMs(s: State): number {
  return performance.now() - s.startedAtPerfMs;
}

function pickStep(t: number): Step {
  // Walk backwards so the most recent step in scope wins; STEPS[0] is the
  // safe fallback for the (impossible) negative-time case.
  for (let i = STEPS.length - 1; i >= 0; i--) {
    const step = STEPS[i];
    if (step !== undefined && t >= step.startMs) return step;
  }
  return STEPS[0]!;
}

function ensureBanner(text: string): void {
  if (!currentSceneCtx) return;
  if (!stepBanner) {
    stepBanner = el('div', { className: 'bh-tutorial-step' });
    currentSceneCtx.overlay.appendChild(stepBanner);
  }
  if (stepBanner.textContent !== text) {
    stepBanner.textContent = text;
  }
}

function exitToTitle(): void {
  const s = state;
  if (!s || s.exited) return;
  s.exited = true;
  // Persist FIRST so a navigate failure (e.g. router transition queue)
  // can't leave the tutorial flag un-set after the player has already
  // played through it. The save is synchronous + best-effort.
  saveSettings({ tutorialSeen: true });
  if (currentSceneCtx) currentSceneCtx.navigate('title');
}

function handleScoringEvent(s: State, ev: ScoringEvent): void {
  // The tutorial intentionally ignores 'fail': the player should keep
  // playing through to the end even if the rock meter empties.
  switch (ev.type) {
    case 'judgment':
      if (ev.judgment === 'miss') {
        if (ev.lane !== undefined) s.effects.spawnMiss(ev.lane, ev.tMs);
      } else if (ev.judgment !== undefined && ev.lane !== undefined) {
        s.effects.spawnHit(ev.lane, ev.judgment, ev.tMs);
        s.bongos.noteHit(ev.lane, ev.judgment, ev.tMs);
      }
      return;
    case 'sp-activated':
      s.effects.spawnStarPowerActivated(ev.tMs);
      return;
    default:
      return;
  }
}

function handleInputEvent(s: State, ev: InputEvent): void {
  if (s.exited) return;
  const tMs = getMasterClockMs(s);
  if (ev.type === 'bongo') {
    s.scoring.pressBongo(ev.lane, tMs);
    return;
  }
  if (ev.action === 'starpower') {
    s.scoring.activateStarPower(tMs);
  }
  // The 'pause' action is intentionally NOT forwarded to the scoring engine;
  // the document-level keydown listener below catches Esc and exits the
  // tutorial outright (returns to title), which is more useful than pausing
  // in a 30-second linear walkthrough.
}

export const tutorialScene: Scene = {
  enter(sceneCtx: SceneContext): void {
    currentSceneCtx = sceneCtx;

    const prepared = prepareChart(tutorialChart, 'hard');
    const notes = new NotesRenderer();
    notes.setChart(prepared.playableChart);

    const background = new BackgroundRenderer();
    background.setBpm(tutorialChart.bpm ?? 100);

    const s: State = {
      prepared,
      scoring: new ScoringEngine(prepared),
      input: null as unknown as KeyboardInput, // wired immediately below
      background,
      highway: new HighwayRenderer(),
      notes,
      effects: new EffectsRenderer(),
      hud: new HudRenderer(),
      bongos: new BongosRenderer(),
      unsubscribers: [],
      startedAtPerfMs: performance.now(),
      exited: false,
      shownStepIdx: -1,
    };
    s.input = new KeyboardInput({ getSongTimeMs: () => getMasterClockMs(s) });
    state = s;

    s.unsubscribers.push(
      s.scoring.on((ev) => {
        if (state === s) handleScoringEvent(s, ev);
      }),
    );
    s.unsubscribers.push(s.input.on((ev) => handleInputEvent(s, ev)));
    s.input.attach();

    // Esc → exit tutorial back to title (replaces the play scene's pause
    // action). Defensive: ignore keystrokes inside text-entry surfaces in
    // case a future overlay adds an input field.
    onKeyDown = (ev: KeyboardEvent): void => {
      const target = ev.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (ev.code === 'Escape') {
        ev.preventDefault();
        exitToTitle();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // Sustain release wiring: identical pattern to the play scene — keyup
    // fires on document BEFORE KeyboardInput's window listener clears its
    // held set, so we defer the check to the next microtask. Mash-style
    // overlap on the same lane therefore can't accidentally close the hold.
    onKeyUp = (ev: KeyboardEvent): void => {
      const target = ev.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      const lane = laneForCode(ev.code);
      if (lane === null) return;
      queueMicrotask(() => {
        if (state !== s) return;
        if (s.input.isLanePressed(lane)) return;
        s.scoring.releaseBongo(lane, getMasterClockMs(s));
      });
    };
    document.addEventListener('keyup', onKeyUp);

    // Force-release on focus loss so a held sustain doesn't auto-complete
    // through an alt-tab.
    onWindowBlur = (): void => {
      if (state !== s) return;
      const t = getMasterClockMs(s);
      s.scoring.releaseBongo('L', t);
      s.scoring.releaseBongo('R', t);
    };
    window.addEventListener('blur', onWindowBlur);

    badge = el('div', { className: 'bh-tutorial-badge' }, ['TUTORIAL']);
    sceneCtx.overlay.appendChild(badge);
    ensureBanner(STEPS[0]!.text);
    s.shownStepIdx = 0;
  },

  exit(sceneCtx: SceneContext): void {
    if (onKeyDown) {
      document.removeEventListener('keydown', onKeyDown);
      onKeyDown = null;
    }
    if (onKeyUp) {
      document.removeEventListener('keyup', onKeyUp);
      onKeyUp = null;
    }
    if (onWindowBlur) {
      window.removeEventListener('blur', onWindowBlur);
      onWindowBlur = null;
    }
    if (stepBanner) {
      stepBanner.remove();
      stepBanner = null;
    }
    if (badge) {
      badge.remove();
      badge = null;
    }
    if (state) {
      for (const un of state.unsubscribers) {
        try {
          un();
        } catch {
          /* ignore */
        }
      }
      state.unsubscribers.length = 0;
      state.input.detach();
      state = null;
    }
    currentSceneCtx = null;
    void sceneCtx;
  },

  draw(sceneCtx: SceneContext, _nowFramePerfMs: number): void {
    currentSceneCtx = sceneCtx;
    const s = state;
    if (!s) return;
    const ctx = sceneCtx.ctx;

    const t = getMasterClockMs(s);
    s.scoring.tick(t);
    const snapshot = s.scoring.snapshot();
    const sp = snapshot.spActive;
    const beatPhase = s.background.beatPhase(t);

    ctx.clearRect(0, 0, STAGE_W, STAGE_H);

    s.background.draw(ctx, { nowMs: t, beatPhase, starPowerActive: sp });

    s.highway.draw(ctx, {
      pressed: { L: s.input.isLanePressed('L'), R: s.input.isLanePressed('R') },
      starPowerActive: sp,
      beatPulse: 1 - beatPhase,
    });

    let heldL = false;
    let heldR = false;
    for (const h of snapshot.activeHolds) {
      if (h.lane === 'L') heldL = true;
      else heldR = true;
    }
    s.notes.draw(ctx, {
      nowMs: t,
      starPowerActive: sp,
      hitNoteIndexes: snapshot.consumed,
      heldL,
      heldR,
    });

    s.effects.draw(ctx, { nowMs: t });

    s.bongos.draw(ctx, {
      nowMs: t,
      pressed: { L: s.input.isLanePressed('L'), R: s.input.isLanePressed('R') },
    });

    s.hud.draw(ctx, {
      snapshot,
      songTimeMs: Math.max(0, t),
      songDurationMs: TUTORIAL_DURATION_MS,
      pressedL: s.input.isLanePressed('L'),
      pressedR: s.input.isLanePressed('R'),
      songTitle: 'Tutorial',
      hideKeyCaps: true,
    });

    // Swap the overlay banner whenever the timeline advances into a new step.
    const step = pickStep(t);
    const idx = STEPS.indexOf(step);
    if (idx !== s.shownStepIdx) {
      s.shownStepIdx = idx;
      ensureBanner(step.text);
    }

    // Auto-exit once the timeline runs out. The Esc handler above can also
    // trigger this earlier; both paths funnel through `exitToTitle()` which
    // is idempotent on `s.exited`.
    if (t >= TUTORIAL_DURATION_MS && !s.exited) {
      exitToTitle();
    }
  },
};
