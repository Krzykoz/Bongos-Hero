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

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
const overlay = document.getElementById('overlay') as HTMLDivElement | null;
if (!canvas) throw new Error('#game canvas missing');
if (!overlay) throw new Error('#overlay div missing');

const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('2D context unavailable');
ctx.imageSmoothingEnabled = true;

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
