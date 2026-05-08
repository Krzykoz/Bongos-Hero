import { describe, expect, it, vi } from 'vitest';

import type { ChartV1 } from '@bongos-hero/shared';

import { laneCenterX, progressToY, scaleAt } from '../geom.js';
import { NotesRenderer } from '../notes.js';

// `noteSprites.ts` lazily allocates an OffscreenCanvas / `<canvas>` on
// first read, neither of which exists under vitest's default `node`
// environment. We don't actually need real sprite bitmaps for these tests
// (the recording ctx swallows `drawImage` calls), so stub them out with a
// minimal shape that satisfies the renderer's `NoteSprite` contract.
vi.mock('../noteSprites.js', () => {
  const stubSource = {} as unknown as HTMLCanvasElement;
  const stub = { source: stubSource, size: 96, anchor: 48 };
  return {
    getNoteSprite: () => stub,
    getSpOverlaySprite: () => stub,
  };
});

/**
 * Minimal recording stub for `CanvasRenderingContext2D` — proxies every
 * method to a no-op except for the handful we want to assert against. Any
 * property writes (`fillStyle = …`) silently succeed. Mirrors the helper
 * in `effects.test.ts`.
 */
interface RecordingCtx {
  ctx: CanvasRenderingContext2D;
  fillCalls: number;
  ellipseCalls: number;
  drawImageCalls: number;
  trapezoids: { x: number; y: number }[][];
}

function makeRecordingCtx(): RecordingCtx {
  let fillCalls = 0;
  let ellipseCalls = 0;
  let drawImageCalls = 0;

  // Active path under construction; pushed into `trapezoids` on each fill so
  // we can later inspect the corner coordinates of the rim/core/stripe quads.
  let activePath: { x: number; y: number }[] = [];
  const trapezoids: { x: number; y: number }[][] = [];

  const store: Record<string, unknown> = {
    beginPath: () => {
      activePath = [];
    },
    moveTo: (x: number, y: number) => {
      activePath.push({ x, y });
    },
    lineTo: (x: number, y: number) => {
      activePath.push({ x, y });
    },
    closePath: () => {
      /* no-op for this stub: closing implicit at fill */
    },
    fill: () => {
      fillCalls++;
      if (activePath.length > 0) {
        trapezoids.push([...activePath]);
      }
    },
    ellipse: () => {
      ellipseCalls++;
    },
    drawImage: () => {
      drawImageCalls++;
    },
  };

  const noop = (): void => {
    /* default ctx method stub */
  };
  const ctx = new Proxy(store, {
    get(target, prop): unknown {
      if (prop in target) return target[prop as string];
      return noop;
    },
    set(target, prop, value): boolean {
      target[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  return {
    ctx,
    get fillCalls() {
      return fillCalls;
    },
    get ellipseCalls() {
      return ellipseCalls;
    },
    get drawImageCalls() {
      return drawImageCalls;
    },
    trapezoids,
  };
}

function makeChart(notes: ChartV1['notes']): ChartV1 {
  return {
    version: 1,
    audioOffsetMs: 0,
    notes,
  };
}

describe('NotesRenderer — sustain trail rendering', () => {
  it('held sustain stays in visibleRange long after the head crossed the hit line', () => {
    // Sustain starts at tMs=0 and lasts 5 s. With the default lateGraceMs
    // of 110, the OLD culling logic would have dropped it from the visible
    // range at nowMs ≈ 110. The new logic must keep it visible until the
    // tail itself clears the grace window (i.e. nowMs ≈ 5110).
    const renderer = new NotesRenderer();
    renderer.setChart(
      makeChart([{ tMs: 0, lane: 'L', durMs: 5_000 }, { tMs: 200, lane: 'R' }]),
    );

    // Walk the cursors forward via successive frames so the visibility
    // pointers behave like they would in a real loop.
    renderer.visibleRange(0);
    renderer.visibleRange(500);
    const mid = renderer.visibleRange(2_500);
    expect(mid.firstIdx).toBe(0); // sustain still alive
    expect(mid.lastIdx).toBeGreaterThanOrEqual(0);

    const late = renderer.visibleRange(5_200);
    // Both notes should be culled now that the sustain's tail has expired.
    expect(late.firstIdx).toBeGreaterThan(late.lastIdx);
  });

  it('sustain trail draws a perspective trapezoid (rim + core + stripe + tail cap)', () => {
    const renderer = new NotesRenderer();
    renderer.setChart(makeChart([{ tMs: 1_000, lane: 'L', durMs: 800 }]));

    const rec = makeRecordingCtx();
    // At nowMs=1000 the head is at the hit line; the tail is ~800 ms back
    // up the highway.
    renderer.draw(rec.ctx, { nowMs: 1_000 });

    // Rim quad + core quad + centre stripe quad + ellipse tail cap. The
    // head sprite is blitted via drawImage.
    expect(rec.fillCalls).toBeGreaterThanOrEqual(3);
    expect(rec.ellipseCalls).toBe(1);
    expect(rec.drawImageCalls).toBeGreaterThanOrEqual(1);

    // Inspect the core quad (second trapezoid: rim is wider, core is the
    // canonical lane-width band). Verify both ends sit on the lane centre
    // and the tail is narrower than the head (perspective taper).
    const core = rec.trapezoids[1];
    expect(core).toBeDefined();
    if (core === undefined) throw new Error('unreachable: assertion above');
    expect(core).toHaveLength(4);

    const headBL = core[0]!;
    const headBR = core[1]!;
    const tailTR = core[2]!;
    const tailTL = core[3]!;

    const cxHead = (headBL.x + headBR.x) * 0.5;
    const cxTail = (tailTL.x + tailTR.x) * 0.5;
    const widthHead = headBR.x - headBL.x;
    const widthTail = tailTR.x - tailTL.x;

    // Head sits at the L-lane centre at progress=1 (hit line); tail sits at
    // the L-lane centre at the tail's progress (further from camera, closer
    // to the highway centreline).
    expect(cxHead).toBeCloseTo(laneCenterX('L', 1), 1);
    expect(headBL.y).toBeCloseTo(progressToY(1), 1);
    expect(tailTL.y).toBeCloseTo(progressToY(1 - 800 / 1500), 1);

    // Tail centre is closer to the highway centre than the head centre
    // (lane convergence) — the original sprite-blit version skipped this.
    expect(Math.abs(cxTail - 640)).toBeLessThan(Math.abs(cxHead - 640));

    // Tail width is smaller than head width by the ratio of the per-Y
    // perspective scales — straight from `geom.scaleAt`.
    const sHead = scaleAt(1);
    const sTail = scaleAt(1 - 800 / 1500);
    expect(widthTail / widthHead).toBeCloseTo(sTail / sHead, 2);
    expect(widthTail).toBeLessThan(widthHead);
  });

  it('non-sustain notes emit no trail fills', () => {
    const renderer = new NotesRenderer();
    renderer.setChart(makeChart([{ tMs: 1_000, lane: 'R' }]));

    const rec = makeRecordingCtx();
    renderer.draw(rec.ctx, { nowMs: 1_000 });

    expect(rec.fillCalls).toBe(0);
    expect(rec.ellipseCalls).toBe(0);
    expect(rec.drawImageCalls).toBeGreaterThanOrEqual(1); // head sprite
  });

  it('held sustain adds a lighter-blend overlay (extra core fill)', () => {
    const renderer = new NotesRenderer();
    renderer.setChart(makeChart([{ tMs: 1_000, lane: 'L', durMs: 800 }]));

    const restingRec = makeRecordingCtx();
    renderer.draw(restingRec.ctx, { nowMs: 1_000, heldL: false });

    const heldRenderer = new NotesRenderer();
    heldRenderer.setChart(makeChart([{ tMs: 1_000, lane: 'L', durMs: 800 }]));
    const heldRec = makeRecordingCtx();
    heldRenderer.draw(heldRec.ctx, { nowMs: 1_000, heldL: true });

    // Held state re-fills the core quad with `lighter` composite; resting
    // state does not. Ellipse + rim + core + stripe = 3 fills + 1 ellipse
    // for resting; held adds one more core fill.
    expect(heldRec.fillCalls).toBe(restingRec.fillCalls + 1);
  });
});
