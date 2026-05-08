/**
 * Minimal scene router for Bongos Hero.
 *
 * One scene is "active" at any time. The router owns the single
 * `requestAnimationFrame` chain and delegates `draw()` to that scene every
 * frame. Transitions are awaited:
 *
 *   1. exit() of the outgoing scene runs (and is awaited).
 *   2. enter() of the incoming scene runs (and is awaited).
 *   3. The incoming scene starts drawing.
 *
 * A 250 ms crossfade overlay is drawn over the canvas during step 1+2: the
 * alpha follows a symmetric trapezoid (rises to 1 at the swap point, falls
 * back to 0). Transitions never block input handling on the *incoming* scene
 * past its `enter()`.
 */

export type SceneId =
  | 'title'
  | 'songSelect'
  | 'import'
  | 'play'
  | 'results'
  | 'calibration'
  | 'settings'
  | 'practice'
  | 'rechart'
  | 'tutorial';

export interface SceneContext {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** The DOM div used for HTML overlay widgets layered above the canvas. */
  overlay: HTMLDivElement;
  /** Trigger a navigation. Returns immediately; transition runs async. */
  navigate(scene: SceneId, payload?: unknown): void;
  /** Optional payload passed by the previous scene's `navigate(...)`. */
  payload?: unknown;
}

export interface Scene {
  enter?(ctx: SceneContext): void | Promise<void>;
  exit?(ctx: SceneContext): void | Promise<void>;
  /** Per-frame draw. `nowMs` is `performance.now()`. */
  draw?(ctx: SceneContext, nowMs: number): void;
}

const TRANSITION_MS = 250;

interface PendingNav {
  to: SceneId;
  payload?: unknown;
}

export class Router {
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLDivElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly scenes = new Map<SceneId, Scene>();

  private currentId: SceneId | null = null;
  private currentScene: Scene | null = null;
  private currentPayload: unknown = undefined;

  /**
   * Set during a transition. While non-null, no scene draws — the router
   * paints a black overlay with `transitionAlpha(now)` every frame instead.
   */
  private transitionStartMs: number | null = null;
  private pendingNav: PendingNav | null = null;
  private transitioning = false;

  private rafId = 0;

  constructor(canvas: HTMLCanvasElement, overlay: HTMLDivElement) {
    this.canvas = canvas;
    this.overlay = overlay;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Router: 2D context unavailable on canvas');
    this.ctx2d = ctx;
  }

  register(id: SceneId, scene: Scene): void {
    this.scenes.set(id, scene);
  }

  async start(initial: SceneId): Promise<void> {
    const first = this.scenes.get(initial);
    if (!first) throw new Error(`Router.start: scene "${initial}" not registered`);

    this.currentId = initial;
    this.currentScene = first;
    this.currentPayload = undefined;
    if (first.enter) {
      await first.enter(this.makeSceneCtx());
    }

    const loop = (nowMs: number): void => {
      this.tick(nowMs);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  // ---- internals ----------------------------------------------------------

  private makeSceneCtx(): SceneContext {
    return {
      canvas: this.canvas,
      ctx: this.ctx2d,
      overlay: this.overlay,
      payload: this.currentPayload,
      navigate: (to, payload) => this.navigate(to, payload),
    };
  }

  private navigate(to: SceneId, payload?: unknown): void {
    if (this.transitioning) {
      // A swap is already in flight; coalesce: the latest target wins.
      this.pendingNav = { to, payload };
      return;
    }
    this.pendingNav = { to, payload };
    void this.runTransition();
  }

  private async runTransition(): Promise<void> {
    this.transitioning = true;
    while (this.pendingNav) {
      const next = this.pendingNav;
      this.pendingNav = null;

      this.transitionStartMs = performance.now();

      // Exit the outgoing scene.
      const outgoing = this.currentScene;
      if (outgoing?.exit) {
        try {
          await outgoing.exit(this.makeSceneCtx());
        } catch (err) {
          console.error('[Router] outgoing exit() threw:', err);
        }
      }

      // Wait for the first half of the crossfade so the user sees the fade
      // *before* the new scene's HTML overlays pop in.
      await waitFor(TRANSITION_MS / 2);

      // Resolve the destination.
      const target = this.scenes.get(next.to);
      if (!target) {
        console.error(`[Router] navigate to unknown scene "${next.to}"`);
        this.transitionStartMs = null;
        break;
      }

      this.currentId = next.to;
      this.currentScene = target;
      this.currentPayload = next.payload;

      if (target.enter) {
        try {
          await target.enter(this.makeSceneCtx());
        } catch (err) {
          console.error(`[Router] enter() of "${next.to}" threw:`, err);
        }
      }

      // Tail half of the crossfade. We let the new scene start drawing
      // beneath the fade-out so it's visible as the alpha returns to 0.
      const elapsedSinceStart = performance.now() - (this.transitionStartMs ?? 0);
      const remaining = TRANSITION_MS - elapsedSinceStart;
      if (remaining > 0) {
        await waitFor(remaining);
      }
      this.transitionStartMs = null;
    }
    this.transitioning = false;
  }

  private tick(nowMs: number): void {
    // Always let the active scene draw, even mid-transition: the overlay sits
    // on top, masking the swap visually.
    if (this.currentScene?.draw) {
      try {
        this.currentScene.draw(this.makeSceneCtx(), nowMs);
      } catch (err) {
        console.error('[Router] scene draw() threw:', err);
      }
    }
    if (this.transitionStartMs !== null) {
      const t = nowMs - this.transitionStartMs;
      const alpha = transitionAlpha(t);
      if (alpha > 0) {
        const ctx = this.ctx2d;
        ctx.save();
        ctx.fillStyle = `rgba(0, 0, 0, ${alpha.toFixed(4)})`;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.restore();
      }
    }
  }
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) resolve();
    else setTimeout(resolve, ms);
  });
}

/**
 * Symmetric trapezoid: 0 → 1 over the first half, plateau is the swap point
 * (alpha = 1 momentarily), then 1 → 0 over the second half.
 */
function transitionAlpha(elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= TRANSITION_MS) return 0;
  const half = TRANSITION_MS / 2;
  if (elapsedMs <= half) return elapsedMs / half;
  return 1 - (elapsedMs - half) / half;
}
