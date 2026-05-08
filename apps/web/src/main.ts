import './style.css';

import { Router } from './router.js';
import { titleScene } from './scenes/title.js';
import { songSelectScene } from './scenes/songSelect.js';
import { importScene } from './scenes/import.js';
import { playScene } from './scenes/play.js';
import { resultsScene } from './scenes/results.js';
import { calibrationScene } from './scenes/calibration.js';
import { settingsScene } from './scenes/settings.js';
import { rechartScene } from './scenes/rechart.js';
import { practiceScene } from './scenes/practice.js';
import { tutorialScene } from './scenes/tutorial.js';
import { loadSettings } from './settings/index.js';

const canvasEl = document.getElementById('game') as HTMLCanvasElement | null;
const overlayEl = document.getElementById('overlay') as HTMLDivElement | null;
if (!canvasEl) throw new Error('#game canvas missing');
if (!overlayEl) throw new Error('#overlay div missing');
// Local non-nullable aliases so the resize closure below sees the narrowed
// types without re-asserting on every access.
const canvas: HTMLCanvasElement = canvasEl;
const overlay: HTMLDivElement = overlayEl;

const ctxOrNull = canvas.getContext('2d');
if (!ctxOrNull) throw new Error('2D context unavailable');
const ctx: CanvasRenderingContext2D = ctxOrNull;
ctx.imageSmoothingEnabled = true;

// ----- Responsive canvas sizing ---------------------------------------------
//
// The renderer always paints in a fixed 1280×720 logical coordinate space.
// We keep that contract by:
//   1. Sizing the canvas's CSS box to fit the viewport while preserving the
//      16:9 aspect ratio (or 9:16 in portrait, after a CSS rotation).
//   2. Sizing the backing store to (1280 × 720) × devicePixelRatio so retina
//      displays render sharp pixels.
//   3. Re-applying ctx.setTransform(dpr, 0, 0, dpr, 0, 0) every time the
//      backing store is resized — `canvas.width = N` resets the context
//      transform back to identity, so the dpr pre-scale must be re-applied
//      AFTER any width / height change.
//
// Portrait detection: when window.innerHeight > innerWidth we set the
// `bh-portrait` class on `<body>`. CSS rules in style.css apply a 90° CW
// rotation to #yt-bg + #game + #overlay so the game appears in landscape
// orientation when the player tilts the phone clockwise. The touch
// hitTest in input/touch.ts un-rotates client coords using the same body
// class, so taps map to the correct lane regardless of orientation.
const STAGE_W = 1280;
const STAGE_H = 720;
let lastDpr = 0;

function applyResponsiveLayout(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const portrait = vh > vw;

  document.body.classList.toggle('bh-portrait', portrait);

  // Compute CSS dimensions of the canvas. In portrait mode the canvas is
  // CSS-rotated 90° around its own centre; the bounding box (which is
  // what the viewport must contain) has its width and height swapped
  // relative to the canvas's own CSS width / height. So in portrait we
  // size the canvas so that bbW = canvas-cssH ≤ vw AND
  // bbH = canvas-cssW ≤ vh — equivalently: cssH ≤ vw, cssW ≤ vh, plus
  // 16:9 aspect. We don't apply these dimensions inline (the CSS file
  // owns that) — the body `bh-portrait` class triggers the rotated CSS
  // ruleset.

  // Backing store sized to logical × dpr for sharp rendering.
  const bsW = Math.round(STAGE_W * dpr);
  const bsH = Math.round(STAGE_H * dpr);
  const dprChanged = dpr !== lastDpr;
  if (canvas.width !== bsW || canvas.height !== bsH) {
    canvas.width = bsW;
    canvas.height = bsH;
  }
  // Setting canvas.width OR a DPR change both require the dpr pre-scale
  // transform to be re-installed. Renderers expect the identity transform
  // to draw in logical space; we hand them a (dpr) scale instead so every
  // draw call is implicitly multiplied up to the backing store size.
  if (dprChanged || canvas.width !== bsW || canvas.height !== bsH) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  lastDpr = dpr;
}

// rAF-debounce so a flurry of resize events (orientationchange + visualViewport
// scroll) collapses to a single layout pass on the next frame.
let resizeQueued = false;
function queueResize(): void {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    applyResponsiveLayout();
  });
}

applyResponsiveLayout();
window.addEventListener('resize', queueResize);
window.addEventListener('orientationchange', queueResize);

const router = new Router(canvas, overlay);
router.register('title', titleScene);
router.register('songSelect', songSelectScene);
router.register('import', importScene);
router.register('play', playScene);
router.register('results', resultsScene);
router.register('calibration', calibrationScene);
router.register('settings', settingsScene);
router.register('rechart', rechartScene);
router.register('practice', practiceScene);
router.register('tutorial', tutorialScene);

// First-run gate: jump straight into the built-in tutorial the first time
// the app boots. The tutorial scene flips `tutorialSeen=true` on completion
// or Esc, so subsequent launches go directly to the title. The `T` hotkey
// on the title scene lets returning players replay it.
const initialScene = loadSettings().tutorialSeen ? 'title' : 'tutorial';
await router.start(initialScene);
