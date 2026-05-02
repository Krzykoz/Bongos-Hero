/**
 * Title scene — first thing the player sees.
 *
 * Big "BONGOS HERO" wordmark with a magenta drop-shadow glow, animated
 * background (continuous BackgroundRenderer at 120 BPM), and a pulsing
 * "mash any LEFT or RIGHT key to start" subtitle.
 *
 * The keydown that advances out of this scene also doubles as the user
 * gesture that lets every subsequent AudioContext.resume() succeed without
 * autoplay-policy errors.
 */

import './scenes.css';
import type { Scene, SceneContext } from '../router.js';
import { laneForCode } from '../input/sides.js';
import { el } from './dom.js';
import { BackgroundRenderer } from '../render/background.js';

const STAGE_W = 1280;
const STAGE_H = 720;

let bg: BackgroundRenderer | null = null;
let titleHint: HTMLDivElement | null = null;

let onKeyDown: ((ev: KeyboardEvent) => void) | null = null;

function ensureBackground(): BackgroundRenderer {
  if (!bg) {
    bg = new BackgroundRenderer();
    bg.setBpm(120);
  }
  return bg;
}

export const titleScene: Scene = {
  enter(sceneCtx: SceneContext): void {
    ensureBackground();

    titleHint = el('div', { className: 'bh-title-hint' }, [
      'press SPACE for calibration  •  mash any LEFT / RIGHT key to start',
    ]);
    sceneCtx.overlay.appendChild(titleHint);

    onKeyDown = (ev: KeyboardEvent): void => {
      // Don't steal text-entry keystrokes (no inputs here, but defensive).
      const target = ev.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (ev.code === 'Space') {
        ev.preventDefault();
        sceneCtx.navigate('calibration');
        return;
      }
      // Any left- or right-side key (the same set used by the mash-mode
      // bongo input) advances to song select.
      if (laneForCode(ev.code) !== null) {
        ev.preventDefault();
        sceneCtx.navigate('songSelect');
      }
    };
    document.addEventListener('keydown', onKeyDown);
  },

  exit(sceneCtx: SceneContext): void {
    if (onKeyDown) {
      document.removeEventListener('keydown', onKeyDown);
      onKeyDown = null;
    }
    if (titleHint) {
      titleHint.remove();
      titleHint = null;
    }
    void sceneCtx;
  },

  draw(sceneCtx: SceneContext, nowMs: number): void {
    const ctx = sceneCtx.ctx;
    const renderer = ensureBackground();
    renderer.draw(ctx, { nowMs });

    ctx.save();

    // Wordmark.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 144px Georgia, "Times New Roman", serif';
    ctx.shadowColor = 'rgba(196, 121, 255, 0.85)';
    ctx.shadowBlur = 60;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#f0e6ff';
    ctx.fillText('BONGOS HERO', STAGE_W / 2, STAGE_H / 2 - 30);

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Subtitle with 1 Hz alpha pulse 0.6 → 1.0.
    const pulse = 0.8 + 0.2 * Math.sin((nowMs / 1000) * Math.PI * 2);
    ctx.globalAlpha = pulse;
    ctx.font = '24px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#f5f0e3';
    ctx.fillText('mash any LEFT or RIGHT key to start', STAGE_W / 2, STAGE_H / 2 + 80);
    ctx.globalAlpha = 1;

    ctx.restore();
  },
};
