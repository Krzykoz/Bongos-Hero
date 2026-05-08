import { describe, expect, it } from 'vitest';

import { EffectsRenderer } from '../effects.js';

/**
 * Recording stub for `CanvasRenderingContext2D` — returns a Proxy that:
 *   - records every method call into `calls`
 *   - bumps dedicated counters for the methods this suite asserts against
 *     (`arc`, `fillRect`, `fillText`)
 *   - silently no-ops every other method (so the upstream `EffectsRenderer`
 *     pipeline can `save / restore / beginPath / stroke / fill / …` freely
 *     without us listing every method explicitly)
 *   - lets property writes succeed (`fillStyle = …`, `font = …`, etc.)
 *
 * `EffectsRenderer.draw()` walks every effect family even when only one is
 * active, but every other family's draw pass early-returns on an empty
 * backing array, so a draw with only milestones spawned exercises ONLY the
 * milestone code path through these recorders.
 */
interface RecordingCtx {
  ctx: CanvasRenderingContext2D;
  arcCalls: number;
  fillRectCalls: number;
  fillTextCalls: { text: string; x: number; y: number }[];
}

function makeRecordingCtx(): RecordingCtx {
  let arcCalls = 0;
  let fillRectCalls = 0;
  const fillTextCalls: { text: string; x: number; y: number }[] = [];

  // Backing object stores property writes (e.g. fillStyle = '#fff') so the
  // Proxy doesn't lose them across reads. Method names map to recorders;
  // unknown method names fall back to a shared no-op via the Proxy `get`.
  const store: Record<string, unknown> = {
    arc: (..._args: unknown[]) => {
      arcCalls++;
    },
    fillRect: (..._args: unknown[]) => {
      fillRectCalls++;
    },
    fillText: (text: string, x: number, y: number) => {
      fillTextCalls.push({ text, x, y });
    },
  };

  const noop = (): void => {
    /* default ctx method stub */
  };
  const ctx = new Proxy(store, {
    get(target, prop): unknown {
      if (prop in target) return target[prop as string];
      // Unknown method or property read → no-op function. The renderer
      // never reads back gradient/path return values for milestones, so
      // returning a function is always safe here.
      return noop;
    },
    set(target, prop, value): boolean {
      target[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  return {
    ctx,
    get arcCalls() {
      return arcCalls;
    },
    get fillRectCalls() {
      return fillRectCalls;
    },
    fillTextCalls,
  };
}

describe('EffectsRenderer — combo milestones', () => {
  it('spawnMilestone claims a pool slot (one wave drawn)', () => {
    const fx = new EffectsRenderer();
    const rec = makeRecordingCtx();

    fx.spawnMilestone(25, 'basic', 0);
    fx.draw(rec.ctx, { nowMs: 50 });

    // The radial wave is the only `arc()` call from the milestone path
    // (basic flavor draws wave only).
    expect(rec.arcCalls).toBe(1);
  });

  it('two simultaneous spawns both render (pool has headroom)', () => {
    const fx = new EffectsRenderer();
    const rec = makeRecordingCtx();

    fx.spawnMilestone(25, 'basic', 0);
    fx.spawnMilestone(50, 'super', 0);
    fx.draw(rec.ctx, { nowMs: 50 });

    // Both flavors draw a wave → 2 `arc` calls. The super flavor also
    // draws two edge bars (left + right) → 2 `fillRect` calls. The basic
    // flavor contributes nothing here.
    expect(rec.arcCalls).toBe(2);
    expect(rec.fillRectCalls).toBe(2);
  });

  it.each([
    [25, 'basic'],
    [50, 'super'],
    [100, 'legend'],
    [150, 'legend'],
    [1000, 'legend'],
  ] as const)('flavor mapping: combo %i → %s draws expected layers', (combo, flavor) => {
    const fx = new EffectsRenderer();
    const rec = makeRecordingCtx();

    fx.spawnMilestone(combo, flavor, 0);
    // Mid-life: 200 ms is inside every flavor's longest layer (text=1100 ms).
    fx.draw(rec.ctx, { nowMs: 200 });

    // Wave (arc) fires for ALL flavors.
    expect(rec.arcCalls).toBe(1);

    // Edge pulse (fillRect ×2) fires for super + legend; basic skips it.
    if (flavor === 'basic') {
      expect(rec.fillRectCalls).toBe(0);
    } else {
      expect(rec.fillRectCalls).toBe(2);
    }

    // Centre `COMBO N!` text is legend-only.
    if (flavor === 'legend') {
      expect(rec.fillTextCalls).toHaveLength(1);
      expect(rec.fillTextCalls[0]?.text).toBe(`COMBO ${combo}!`);
    } else {
      expect(rec.fillTextCalls).toHaveLength(0);
    }
  });

  it('milestone deactivates after its full duration elapses', () => {
    const fx = new EffectsRenderer();
    const rec = makeRecordingCtx();

    // Legend has the longest tail (1100 ms text); pick 2000 ms to land
    // safely past every layer's lifeMs for every flavor.
    fx.spawnMilestone(100, 'legend', 0);
    fx.draw(rec.ctx, { nowMs: 2000 });

    // Past life → no wave / edge / text from this milestone.
    expect(rec.arcCalls).toBe(0);
    expect(rec.fillRectCalls).toBe(0);
    expect(rec.fillTextCalls).toHaveLength(0);

    // And the slot must now be reusable: a fresh spawn renders again.
    const rec2 = makeRecordingCtx();
    fx.spawnMilestone(25, 'basic', 2000);
    fx.draw(rec2.ctx, { nowMs: 2050 });
    expect(rec2.arcCalls).toBe(1);
  });

  it('render() does NOT allocate (Array.prototype.push not called per draw)', () => {
    const fx = new EffectsRenderer();

    // Saturate the milestone pool with 5 spawns (pool size is 4 — the 5th
    // is a no-op). Then draw repeatedly: a correctly-pooled implementation
    // never push()es into ANY internal array during the draw.
    fx.spawnMilestone(25, 'basic', 0);
    fx.spawnMilestone(50, 'super', 0);
    fx.spawnMilestone(100, 'legend', 0);
    fx.spawnMilestone(150, 'legend', 0);
    fx.spawnMilestone(200, 'legend', 0);

    // Push-free recorder: use plain integer counters only so the harness
    // itself contributes zero `push` calls. Otherwise the global
    // `Array.prototype.push` patch below would catch the test's own
    // bookkeeping rather than just the production code path.
    let arcCount = 0;
    let fillRectCount = 0;
    let fillTextCount = 0;
    const noop = (): void => {
      /* default ctx method stub */
    };
    const store: Record<string, unknown> = {
      arc: () => {
        arcCount++;
      },
      fillRect: () => {
        fillRectCount++;
      },
      fillText: () => {
        fillTextCount++;
      },
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

    const realPush = Array.prototype.push;
    let pushCallCount = 0;
    Array.prototype.push = function patchedPush<T>(this: T[], ...items: T[]): number {
      pushCallCount++;
      return realPush.apply(this, items);
    };

    try {
      for (let i = 0; i < 5; i++) {
        fx.draw(ctx, { nowMs: 50 + i * 10 });
      }
    } finally {
      Array.prototype.push = realPush;
    }

    expect(pushCallCount).toBe(0);

    // And the saturation contract held: only 4 waves drew per frame even
    // though 5 spawns were issued (pool size 4). 5 frames × 4 slots = 20
    // arc calls in total; 3 of those slots are super/legend → edge-bar
    // pairs (3 × 2) per frame; 2 are legend → 1 fillText per frame.
    expect(arcCount).toBe(5 * 4);
    expect(fillRectCount).toBe(5 * 3 * 2);
    expect(fillTextCount).toBe(5 * 2);
  });
});

describe('EffectsRenderer — confetti', () => {
  it('spawnConfetti claims the requested number of pool slots', () => {
    const fx = new EffectsRenderer();
    const claimed = fx.spawnConfetti(640, 360, 12, 0);
    // Pool ceiling is 80 — 12 fits comfortably.
    expect(claimed).toBe(12);

    const rec = makeRecordingCtx();
    // Draw immediately on spawn (lifeT = 0 → full alpha) so each live
    // particle contributes exactly one fillRect to the recording ctx.
    fx.draw(rec.ctx, { nowMs: 0 });
    expect(rec.fillRectCalls).toBe(12);
  });

  it('spawnConfetti caps at the pool ceiling and reports the actual count', () => {
    const fx = new EffectsRenderer();
    // Pool size is 80; ask for 200 to exhaust it.
    const claimed = fx.spawnConfetti(640, 360, 200, 0);
    expect(claimed).toBe(80);

    const rec = makeRecordingCtx();
    fx.draw(rec.ctx, { nowMs: 0 });
    expect(rec.fillRectCalls).toBe(80);
  });

  it('confetti decays after its lifetime and slots become reusable', () => {
    const fx = new EffectsRenderer();
    fx.spawnConfetti(640, 360, 10, 0);

    // 1) During life: every active slot draws a rectangle.
    const rec1 = makeRecordingCtx();
    fx.draw(rec1.ctx, { nowMs: 100 });
    expect(rec1.fillRectCalls).toBe(10);

    // 2) Past lifetime (CONFETTI_LIFETIME_MS = 2400 ms): every slot has
    //    flipped to inactive, so no rectangles draw and the spawn slot
    //    pool has 80 free spots again.
    const rec2 = makeRecordingCtx();
    fx.draw(rec2.ctx, { nowMs: 5000 });
    expect(rec2.fillRectCalls).toBe(0);

    // 3) Slots are reusable: a fresh spawn finds room.
    const claimed = fx.spawnConfetti(0, 0, 80, 5000);
    expect(claimed).toBe(80);
  });

  it('5★ helper splits the burst across two cannons (~50 total)', () => {
    const fx = new EffectsRenderer();
    fx.spawnConfettiFor5Star({ width: 1280, height: 720 }, 0);

    const rec = makeRecordingCtx();
    fx.draw(rec.ctx, { nowMs: 0 });
    // Helper claims CONFETTI_5_STAR_COUNT = 50 slots total across L+R.
    expect(rec.fillRectCalls).toBe(50);
  });

  it('4★ helper spawns the small centre burst (~20 total, no stinger)', () => {
    const fx = new EffectsRenderer();
    fx.spawnSmallBurstFor4Star({ width: 1280, height: 720 }, 0);

    const rec = makeRecordingCtx();
    fx.draw(rec.ctx, { nowMs: 0 });
    expect(rec.fillRectCalls).toBe(20);
  });

  it('confetti draw does NOT allocate (Array.prototype.push not called)', () => {
    const fx = new EffectsRenderer();
    // Saturate near pool capacity so the draw walks plenty of live slots.
    fx.spawnConfetti(640, 360, 80, 0);

    let fillRectCount = 0;
    const noop = (): void => {
      /* default ctx method stub */
    };
    const store: Record<string, unknown> = {
      fillRect: () => {
        fillRectCount++;
      },
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

    const realPush = Array.prototype.push;
    let pushCallCount = 0;
    Array.prototype.push = function patchedPush<T>(this: T[], ...items: T[]): number {
      pushCallCount++;
      return realPush.apply(this, items);
    };

    try {
      // Step a few frames so the integration loop runs with real dt.
      for (let i = 0; i < 5; i++) {
        fx.draw(ctx, { nowMs: 50 + i * 16 });
      }
    } finally {
      Array.prototype.push = realPush;
    }

    expect(pushCallCount).toBe(0);
    // Sanity: the per-frame draw actually rendered the live slots.
    expect(fillRectCount).toBeGreaterThan(0);
  });
});
