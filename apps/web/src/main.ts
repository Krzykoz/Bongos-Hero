import './style.css';

import { Router } from './router.js';
import { titleScene } from './scenes/title.js';
import { songSelectScene } from './scenes/songSelect.js';
import { importScene } from './scenes/import.js';
import { playScene } from './scenes/play.js';
import { resultsScene } from './scenes/results.js';
import { calibrationScene } from './scenes/calibration.js';

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

await router.start('title');
