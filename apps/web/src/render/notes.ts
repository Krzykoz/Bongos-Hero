/**
 * Note renderer for the Bongos Hero highway.
 *
 * Walks two ascending cursors (`firstIdx` / `lastIdx`) over the chart's note
 * array so that per-frame work is O(notes spawned/culled this frame), not
 * O(N). For each visible note we compute its `progress` along the highway
 * (0 at the spawn line, 1 at the hit line), then convert that into screen-
 * space coordinates and a uniform scale via the pure functions in `geom.ts`.
 *
 * Drum heads and the SP overlay are blitted from the pre-rasterised sprites
 * in `noteSprites.ts` (cheap per-frame). Sustain trails, on the other hand,
 * are drawn as live paths because they need to follow the highway's
 * perspective (lane convergence + per-Y scale) — a fixed bitmap can't taper
 * toward the vanishing point, so a uniformly-scaled sprite always overshoots
 * the lane edges at the far end. The path-based trapezoid is exact for the
 * current linear lane geometry and stays cheap (3-4 fills per visible
 * sustain).
 *
 * ## Settings hooks
 *
 * - `settings.scrollSpeedMul` (0.5..2.0) scales the spawn-to-hit travel time
 *   inversely: 2.0 = travel twice as fast (`travelMs / 2`), 0.5 = travel
 *   half as fast (`travelMs * 2`). The hit-line position (progress=1) is
 *   independent of `travelMs`, so changing scroll speed does NOT shift it.
 * - `settings.colorBlind` is handled upstream in `theme.ts`; the renderer
 *   just compares the active palette epoch and refreshes its cached sprite
 *   handles AND its derived trail colours when it changes.
 */

import type { ChartNote, ChartV1 } from '@bongos-hero/shared';

import { loadSettings, subscribe } from '../settings/index.js';
import { darkenHex, lightenHex } from './color.js';
import { laneCenterX, progressToY, scaleAt } from './geom.js';
import { getNoteSprite, getSpOverlaySprite, type NoteSprite } from './noteSprites.js';
import { getPaletteEpoch, THEME } from './theme.js';

const DEFAULT_TRAVEL_MS = 1500;
const DEFAULT_LATE_GRACE_MS = 110;

/**
 * Width of a sustain trail at the hit line (progress=1) in CSS px. The
 * renderer scales it down toward the vanishing point with the same factor
 * as the head, so the tail end naturally tapers. Tuned to read clearly
 * under the drum head without overpowering it (~half the head diameter).
 */
const TRAIL_BASE_WIDTH = 48;

/**
 * Width (px at the hit line) of the dark rim drawn around each trail. The
 * rim itself is scaled by the head's perspective factor at each end, so it
 * remains visually proportional from spawn to hit line.
 */
const TRAIL_RIM_BASE = 2;

/**
 * If `nowMs` jumps backwards by more than this, we treat it as a user scrub
 * and re-scan the note array from the start to rebuild the cursors. A 100 ms
 * threshold is generous enough that ordinary clock jitter is ignored.
 */
const BACKWARDS_SEEK_THRESHOLD_MS = 100;

/**
 * Module-level scroll-speed multiplier driven by `settings.scrollSpeedMul`.
 * Read at module init AND kept fresh via `settings.subscribe` so a change to
 * the slider updates the next frame without anyone touching the rAF loop.
 *
 * The multiplier scales the *speed* — so the effective travel time is
 * `baseTravelMs / currentScrollSpeedMul`. Larger value = faster scroll =
 * shorter time on screen.
 */
let currentScrollSpeedMul = loadSettings().scrollSpeedMul;
subscribe((s) => {
  currentScrollSpeedMul = s.scrollSpeedMul;
});

export interface NotesRendererOptions {
  /** Travel time from spawn line to hit line, in ms. Default 1500. */
  travelMs?: number;
  /** Late-hit grace in ms after a note's tMs before culling. Default 110. */
  lateGraceMs?: number;
}

export interface NotesRenderState {
  /** Current song time in ms (audio-clock derived). */
  nowMs: number;
  /** True if star power is currently active (notes glow brighter). */
  starPowerActive?: boolean;
  /** When provided, these note indexes will be skipped in rendering (already hit). */
  hitNoteIndexes?: ReadonlySet<number>;
  /**
   * True if the player currently has the L-lane sustain key held. Drives
   * the brightened "live" trail look while the hold is in progress, and
   * keeps consumed-but-still-held sustain notes visible (trail only, head
   * suppressed) while they accumulate score. No-op for non-sustain notes
   * and when no L sustain is currently active.
   */
  heldL?: boolean;
  /** Same as `heldL`, for the R lane. */
  heldR?: boolean;
}

export class NotesRenderer {
  /** Base travel time in ms before the user-facing scroll-speed multiplier. */
  readonly baseTravelMs: number;
  /** Late-hit grace window in ms (read-only after construction). */
  readonly lateGraceMs: number;

  #chart: ChartV1 | null = null;
  #notes: readonly ChartNote[] = [];

  /** Index of the oldest note still in the active window. */
  #firstIdx = 0;
  /** Index of the newest note that has already crossed the spawn threshold. */
  #lastIdx = -1;
  /** Last `nowMs` we observed; used to detect backwards seeks. */
  #lastSeenNowMs = -Infinity;
  /** True once we've already warned about an unsorted chart this session. */
  #warnedUnsorted = false;

  // Cached sprite handles. Built lazily on the first `draw` so constructing
  // a renderer never touches Canvas APIs (handy for tests / SSR contexts).
  // Re-fetched whenever the active palette epoch advances (color-blind
  // toggle), since `noteSprites.ts` clears its cache and rebuilds against
  // the new palette.
  #spriteL: NoteSprite | null = null;
  #spriteR: NoteSprite | null = null;
  #spOverlay: NoteSprite | null = null;
  #spritePaletteEpoch = -1;

  // Pre-extracted numeric anchors / sizes so the hot loop never has to deref
  // through the sprite struct.
  #anchorL = 0;
  #anchorR = 0;
  #sizeL = 0;
  #sizeR = 0;
  #anchorSp = 0;
  #sizeSp = 0;

  // Cached trail colour strings, derived from the active palette. Same
  // epoch-polling trick as the sprite cache: rebuild lazily when the palette
  // toggles. Each lane gets a fill (lane base), a darker rim, and a lighter
  // centre stripe so the trail reads as a glowing rope without needing
  // gradient allocations per frame.
  #trailFillL = '';
  #trailRimL = '';
  #trailLitL = '';
  #trailFillR = '';
  #trailRimR = '';
  #trailLitR = '';
  #trailPaletteEpoch = -1;

  constructor(opts: NotesRendererOptions = {}) {
    this.baseTravelMs = opts.travelMs ?? DEFAULT_TRAVEL_MS;
    this.lateGraceMs = opts.lateGraceMs ?? DEFAULT_LATE_GRACE_MS;
  }

  /**
   * Effective spawn-to-hit travel time, in ms, after applying the live
   * `settings.scrollSpeedMul`. Larger multiplier = faster scroll = smaller
   * value here. Re-evaluated on every read so a settings change is picked
   * up by the next frame without any extra plumbing.
   *
   * The hit-line position is at `progress = 1`, which is independent of
   * `travelMs` (`progress = 1 - deltaMs / travelMs`, deltaMs=0 → 1), so
   * changing the scroll speed never moves the hit line.
   */
  get travelMs(): number {
    return this.baseTravelMs / currentScrollSpeedMul;
  }

  /** Returns the loaded chart's `audioOffsetMs`, or 0 if no chart is loaded. */
  get audioOffsetMs(): number {
    return this.#chart?.audioOffsetMs ?? 0;
  }

  /** Total notes in the loaded chart (0 before `setChart`). */
  get totalNotes(): number {
    return this.#notes.length;
  }

  /**
   * Load a chart. Resets internal cursors; safe to call mid-song to swap
   * songs. Notes are expected to be sorted ascending by `tMs`; we scan once
   * and emit a single warning if not.
   */
  setChart(chart: ChartV1): void {
    this.#chart = chart;
    this.#notes = chart.notes;
    this.#firstIdx = 0;
    this.#lastIdx = -1;
    this.#lastSeenNowMs = -Infinity;

    if (!this.#warnedUnsorted) {
      for (let i = 1; i < this.#notes.length; i++) {
        const prev = this.#notes[i - 1];
        const cur = this.#notes[i];
        if (prev !== undefined && cur !== undefined && cur.tMs < prev.tMs) {
          console.warn(
            'NotesRenderer: chart notes are not sorted ascending by tMs; ' +
              'cursor walking will be incorrect.',
          );
          this.#warnedUnsorted = true;
          break;
        }
      }
    }
  }

  /**
   * Returns the inclusive index range of notes currently in the active
   * window `[nowMs - lateGraceMs, nowMs + travelMs]`.
   *
   * Cursors only ever march forward except on a detected backwards seek
   * (a `nowMs` regression of more than `BACKWARDS_SEEK_THRESHOLD_MS`), so
   * amortised cost per call is O(notes spawned + notes culled this frame).
   *
   * For an empty chart returns `{ firstIdx: 0, lastIdx: -1 }`.
   */
  visibleRange(nowMs: number): { firstIdx: number; lastIdx: number } {
    const notes = this.#notes;
    if (notes.length === 0) {
      return { firstIdx: 0, lastIdx: -1 };
    }

    if (nowMs < this.#lastSeenNowMs - BACKWARDS_SEEK_THRESHOLD_MS) {
      this.#firstIdx = 0;
      this.#lastIdx = -1;
    }
    this.#lastSeenNowMs = nowMs;

    const spawnTime = nowMs + this.travelMs;
    const cullTime = nowMs - this.lateGraceMs;

    // Spawn newly-visible notes by advancing `lastIdx` while the next note
    // has crossed the spawn threshold (`tMs <= nowMs + travelMs`).
    while (this.#lastIdx + 1 < notes.length) {
      const next = notes[this.#lastIdx + 1];
      if (next === undefined || next.tMs > spawnTime) break;
      this.#lastIdx++;
    }

    // Cull old notes by advancing `firstIdx` while the current note is fully
    // expired (`nowMs > tMs + durMs + lateGraceMs`, i.e. `tMs + durMs <
    // cullTime`). For regular notes `durMs === 0` so this collapses to the
    // original "head past the late-grace window" rule. For sustains it
    // keeps the note alive until its tail clears the grace window, so a
    // long held sustain doesn't disappear mid-hold. The cursor temporarily
    // pauses on a long sustain; the per-frame draw cost (a handful of
    // already-consumed iterations short-circuited at the `consumed && !held`
    // check) is dominated by the sustain itself anyway.
    while (this.#firstIdx <= this.#lastIdx) {
      const cur = notes[this.#firstIdx];
      if (cur === undefined) break;
      const endMs = cur.tMs + (cur.durMs ?? 0);
      if (endMs >= cullTime) break;
      this.#firstIdx++;
    }

    return { firstIdx: this.#firstIdx, lastIdx: this.#lastIdx };
  }

  /**
   * Draw all currently visible notes, skipping any indexes the caller has
   * marked as already hit — *unless* the index is a sustain note that is
   * still being held (in which case we draw the trail with the head
   * suppressed so the player sees what they're holding through). The entire
   * draw is wrapped in `save`/`restore` so any composite-op or alpha
   * changes never leak out of this renderer.
   */
  draw(ctx: CanvasRenderingContext2D, state: NotesRenderState): void {
    const notes = this.#notes;
    if (notes.length === 0) return;

    const { firstIdx, lastIdx } = this.visibleRange(state.nowMs);
    if (firstIdx > lastIdx) return;

    this.#ensureSprites();
    this.#ensureTrailColors();

    // Pull all hot-loop dependencies into local consts so the JIT can keep
    // them in registers and we never re-read instance state per note.
    const spriteL = this.#spriteL!;
    const spriteR = this.#spriteR!;
    const spOverlay = this.#spOverlay!;
    const sourceL = spriteL.source;
    const sourceR = spriteR.source;
    const sourceSp = spOverlay.source;
    const anchorL = this.#anchorL;
    const anchorR = this.#anchorR;
    const sizeL = this.#sizeL;
    const sizeR = this.#sizeR;
    const anchorSp = this.#anchorSp;
    const sizeSp = this.#sizeSp;
    const trailFillL = this.#trailFillL;
    const trailRimL = this.#trailRimL;
    const trailLitL = this.#trailLitL;
    const trailFillR = this.#trailFillR;
    const trailRimR = this.#trailRimR;
    const trailLitR = this.#trailLitR;

    const travelMs = this.travelMs;
    const nowMs = state.nowMs;
    const hitSet = state.hitNoteIndexes;
    const sp = state.starPowerActive === true;
    const heldL = state.heldL === true;
    const heldR = state.heldR === true;
    const ghostFactor = 1.18;

    ctx.save();

    for (let i = firstIdx; i <= lastIdx; i++) {
      const note = notes[i];
      if (note === undefined) continue;

      const isL = note.lane === 'L';
      const consumed = hitSet?.has(i) === true;
      const durMs = note.durMs ?? 0;
      const isSustain = durMs > 0;
      const held = isSustain && (isL ? heldL : heldR);

      // A consumed regular note (or a consumed sustain whose hold ended)
      // is fully dismissed — same short-circuit as before. A consumed
      // sustain that is STILL being held continues to render its trail
      // (with the head suppressed) so the player can see how much hold
      // time they have left.
      if (consumed && !held) continue;

      const deltaMs = note.tMs - nowMs;
      let headP = 1 - deltaMs / travelMs;
      if (headP < 0) headP = 0;
      else if (headP > 1) headP = 1;

      const cx = laneCenterX(note.lane, headP);
      const cy = progressToY(headP);
      const s = scaleAt(headP);

      // ---- Trail (drawn first so the head occludes the bottom edge) ----
      if (isSustain) {
        let tailP = 1 - (deltaMs + durMs) / travelMs;
        if (tailP < 0) tailP = 0;
        else if (tailP > 1) tailP = 1;

        const yTail = progressToY(tailP);
        const trailHeightPx = cy - yTail;
        if (trailHeightPx > 0.5) {
          // Both ends use their own perspective: the head end uses the
          // head's `cx` / `s`, the tail end uses its own laneCenterX +
          // scaleAt so the trail tapers AND tracks the lane's convergence
          // toward the vanishing point. With the current geometry both
          // halfWidth and laneCenterX are linear in screen-Y, so a four-
          // corner straight-edge trapezoid is exact (not an approximation).
          const sTail = scaleAt(tailP);
          const cxTail = laneCenterX(note.lane, tailP);
          const halfHead = TRAIL_BASE_WIDTH * 0.5 * s;
          const halfTail = TRAIL_BASE_WIDTH * 0.5 * sTail;
          const rimHead = TRAIL_RIM_BASE * s;
          const rimTail = TRAIL_RIM_BASE * sTail;

          const restingAlpha = 0.7;
          ctx.globalAlpha = held ? 1 : restingAlpha;

          // 1. Outer rim quad: slightly wider than the core at both ends so
          //    a thin dark outline reads even when the trail shrinks far up
          //    the highway.
          ctx.beginPath();
          ctx.moveTo(cx - (halfHead + rimHead), cy);
          ctx.lineTo(cx + (halfHead + rimHead), cy);
          ctx.lineTo(cxTail + (halfTail + rimTail), yTail);
          ctx.lineTo(cxTail - (halfTail + rimTail), yTail);
          ctx.closePath();
          ctx.fillStyle = isL ? trailRimL : trailRimR;
          ctx.fill();

          // 2. Inner core quad: the lane fill colour. This is the dominant
          //    visual layer.
          ctx.beginPath();
          ctx.moveTo(cx - halfHead, cy);
          ctx.lineTo(cx + halfHead, cy);
          ctx.lineTo(cxTail + halfTail, yTail);
          ctx.lineTo(cxTail - halfTail, yTail);
          ctx.closePath();
          ctx.fillStyle = isL ? trailFillL : trailFillR;
          ctx.fill();

          // 3. Centre highlight stripe (~18% of width). Slightly lighter
          //    than the lane fill so the trail reads as glossy rather than
          //    flat. Sits inside the core quad with the same trapezoid
          //    geometry so it follows the perspective taper too.
          const stripeHead = halfHead * 0.18;
          const stripeTail = halfTail * 0.18;
          ctx.beginPath();
          ctx.moveTo(cx - stripeHead, cy);
          ctx.lineTo(cx + stripeHead, cy);
          ctx.lineTo(cxTail + stripeTail, yTail);
          ctx.lineTo(cxTail - stripeTail, yTail);
          ctx.closePath();
          const prevAlpha = ctx.globalAlpha;
          ctx.globalAlpha = prevAlpha * 0.55;
          ctx.fillStyle = isL ? trailLitL : trailLitR;
          ctx.fill();
          ctx.globalAlpha = prevAlpha;

          // 4. Tail cap: a half-ellipse at the upstream end so the trail
          //    doesn't terminate in a hard square edge. Uses the core fill
          //    colour and matches the tail's perspective scale.
          if (halfTail > 0.5) {
            ctx.beginPath();
            ctx.ellipse(cxTail, yTail, halfTail, halfTail * 0.5, 0, Math.PI, Math.PI * 2);
            ctx.fillStyle = isL ? trailFillL : trailFillR;
            ctx.fill();
          }

          // 5. Held overlay: additive lighter blend on the core quad so the
          //    rope visibly brightens while the player keeps the bongo
          //    pressed.
          if (held) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.45;
            ctx.beginPath();
            ctx.moveTo(cx - halfHead, cy);
            ctx.lineTo(cx + halfHead, cy);
            ctx.lineTo(cxTail + halfTail, yTail);
            ctx.lineTo(cxTail - halfTail, yTail);
            ctx.closePath();
            ctx.fillStyle = isL ? trailFillL : trailFillR;
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
          }
          ctx.globalAlpha = 1;
        }
      }

      // A consumed-but-held sustain only renders its trail — the head was
      // already destroyed by the player's hit, and the SP overlay rides
      // along with the head, so it goes away too.
      if (consumed) continue;

      const source = isL ? sourceL : sourceR;
      const anchor = isL ? anchorL : anchorR;
      const size = isL ? sizeL : sizeR;

      const drawSize = size * s;
      const dx = cx - anchor * s;
      const dy = cy - anchor * s;

      if (sp) {
        // Tasteful additive bloom under every note while SP is active.
        // Same sprite, slightly larger, blended with `lighter` so it just
        // brightens existing pixels rather than washing the colour out.
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.35;
        const ghostSize = drawSize * ghostFactor;
        const ghostOffset = (ghostSize - drawSize) * 0.5;
        ctx.drawImage(source, dx - ghostOffset, dy - ghostOffset, ghostSize, ghostSize);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      ctx.drawImage(source, dx, dy, drawSize, drawSize);

      if (note.sp === true) {
        ctx.globalCompositeOperation = 'screen';
        const spSize = sizeSp * s;
        const spDx = cx - anchorSp * s;
        const spDy = cy - anchorSp * s;
        ctx.drawImage(sourceSp, spDx, spDy, spSize, spSize);
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    ctx.restore();
  }

  // ---- internals ------------------------------------------------------------

  /**
   * Lazily build and memoise the lane / SP sprites and their anchor consts.
   * On a palette change (color-blind toggle), `noteSprites.ts` clears its
   * own caches and `getPaletteEpoch()` advances; we mirror that here by
   * dropping our cached handles so the next draw rebuilds against the new
   * palette. Anchor / size are constant across palettes (sprite geometry
   * is palette-independent) so the recomputed values always agree.
   */
  #ensureSprites(): void {
    const epoch = getPaletteEpoch();
    if (epoch !== this.#spritePaletteEpoch) {
      this.#spriteL = null;
      this.#spriteR = null;
      this.#spOverlay = null;
      this.#spritePaletteEpoch = epoch;
    }
    if (this.#spriteL === null) {
      const s = getNoteSprite('L');
      this.#spriteL = s;
      this.#anchorL = s.anchor;
      this.#sizeL = s.size;
    }
    if (this.#spriteR === null) {
      const s = getNoteSprite('R');
      this.#spriteR = s;
      this.#anchorR = s.anchor;
      this.#sizeR = s.size;
    }
    if (this.#spOverlay === null) {
      const s = getSpOverlaySprite();
      this.#spOverlay = s;
      this.#anchorSp = s.anchor;
      this.#sizeSp = s.size;
    }
  }

  /**
   * Refresh the cached trail colour strings if the active palette has
   * changed since we last computed them. Polled rather than push-
   * subscribed because we already poll `getPaletteEpoch()` for the sprite
   * cache; one epoch counter drives both.
   */
  #ensureTrailColors(): void {
    const epoch = getPaletteEpoch();
    if (epoch === this.#trailPaletteEpoch) return;
    this.#trailFillL = THEME.laneL.fill;
    this.#trailRimL = darkenHex(THEME.laneL.fill, 0.45);
    this.#trailLitL = lightenHex(THEME.laneL.fill, 0.55);
    this.#trailFillR = THEME.laneR.fill;
    this.#trailRimR = darkenHex(THEME.laneR.fill, 0.45);
    this.#trailLitR = lightenHex(THEME.laneR.fill, 0.55);
    this.#trailPaletteEpoch = epoch;
  }
}
