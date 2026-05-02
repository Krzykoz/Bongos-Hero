/**
 * Standalone visual demo for the `NotesRenderer`.
 *
 * NOT auto-imported from `main.ts`. A human (or the next agent) can wire it
 * up to a `<canvas>` to eyeball spawn cadence, perspective scaling, lane
 * placement, and the Star-Power overlay without the rest of the game wired
 * in.
 *
 * Example:
 *
 *     import { runNotesDemo } from './render/__notesDemo__.js';
 *     const cancel = runNotesDemo(document.querySelector('canvas')!);
 *     // ...later...
 *     cancel();
 */

import type { ChartNote, ChartV1, Lane } from '@bongos-hero/shared';

import { STAGE_H, STAGE_W } from './geom.js';
import { HighwayRenderer, type HighwayRenderState } from './highway.js';
import { NotesRenderer } from './notes.js';

export function runNotesDemo(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('runNotesDemo: 2D context unavailable');
  }

  // Lock the backing store to the design resolution so the demo is self-
  // contained; CSS sizing on the page can scale it however it likes.
  canvas.width = STAGE_W;
  canvas.height = STAGE_H;

  // Synthetic chart: 60 notes alternating L/R every 250 ms starting at
  // tMs = 1000. Every 12th note is flagged as Star-Power (sp:true).
  const notes: ChartNote[] = [];
  for (let i = 0; i < 60; i++) {
    const lane: Lane = i % 2 === 0 ? 'L' : 'R';
    const note: ChartNote = { tMs: 1000 + i * 250, lane };
    if (i % 12 === 11) note.sp = true;
    notes.push(note);
  }

  const chart: ChartV1 = {
    version: 1,
    audioOffsetMs: 0,
    notes,
  };

  const lastNote = chart.notes[chart.notes.length - 1];
  // 2 s of silence past the last note before the song loops back to the top
  // — long enough that the late-grace cull always fires before respawn.
  const loopMs = (lastNote?.tMs ?? 0) + 2000;

  const highway = new HighwayRenderer();
  const highwayState: HighwayRenderState = {
    pressed: { L: false, R: false },
    starPowerActive: false,
    beatPulse: 0,
  };

  const noteRenderer = new NotesRenderer();
  noteRenderer.setChart(chart);

  let rafId = 0;
  const startMs = performance.now();

  const frame = (): void => {
    const elapsed = performance.now() - startMs;
    const nowMs = elapsed % loopMs;

    highway.draw(ctx, highwayState);
    noteRenderer.draw(ctx, { nowMs });

    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  return (): void => {
    cancelAnimationFrame(rafId);
  };
}
