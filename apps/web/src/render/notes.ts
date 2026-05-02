/**
 * Note renderer for the Bongos Hero highway.
 *
 * Walks two ascending cursors (`firstIdx` / `lastIdx`) over the chart's note
 * array so that per-frame work is O(notes spawned/culled this frame), not
 * O(N). For each visible note we compute its `progress` along the highway
 * (0 at the spawn line, 1 at the hit line), then convert that into screen-
 * space coordinates and a uniform scale via the pure functions in `geom.ts`.
 *
 * Drawing is exclusively `drawImage`-based: every drum-head texture is
 * pre-rasterised once by `noteSprites.ts` and blitted from there. The hot
 * loop allocates nothing.
 */

import type { ChartNote, ChartV1 } from '@bongos-hero/shared';

import { laneCenterX, progressToY, scaleAt } from './geom.js';
import {
  getNoteSprite,
  getSpOverlaySprite,
  type NoteSprite,
} from './noteSprites.js';

const DEFAULT_TRAVEL_MS = 1500;
const DEFAULT_LATE_GRACE_MS = 110;

/**
 * If `nowMs` jumps backwards by more than this, we treat it as a user scrub
 * and re-scan the note array from the start to rebuild the cursors. A 100 ms
 * threshold is generous enough that ordinary clock jitter is ignored.
 */
const BACKWARDS_SEEK_THRESHOLD_MS = 100;

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
}

export class NotesRenderer {
  /** Travel time in ms (read-only after construction). */
  readonly travelMs: number;
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
  #spriteL: NoteSprite | null = null;
  #spriteR: NoteSprite | null = null;
  #spOverlay: NoteSprite | null = null;

  // Pre-extracted numeric anchors / sizes so the hot loop never has to deref
  // through the sprite struct.
  #anchorL = 0;
  #anchorR = 0;
  #sizeL = 0;
  #sizeR = 0;
  #anchorSp = 0;
  #sizeSp = 0;

  constructor(opts: NotesRendererOptions = {}) {
    this.travelMs = opts.travelMs ?? DEFAULT_TRAVEL_MS;
    this.lateGraceMs = opts.lateGraceMs ?? DEFAULT_LATE_GRACE_MS;
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
          // eslint-disable-next-line no-console
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

    // Cull old notes by advancing `firstIdx` while the current head has
    // expired (`nowMs > tMs + lateGraceMs` i.e. `tMs < cullTime`).
    while (this.#firstIdx <= this.#lastIdx) {
      const cur = notes[this.#firstIdx];
      if (cur === undefined || cur.tMs >= cullTime) break;
      this.#firstIdx++;
    }

    return { firstIdx: this.#firstIdx, lastIdx: this.#lastIdx };
  }

  /**
   * Draw all currently visible notes, skipping any indexes the caller has
   * marked as already hit. The entire draw is wrapped in `save`/`restore`
   * so any composite-op or alpha changes never leak out of this renderer.
   */
  draw(ctx: CanvasRenderingContext2D, state: NotesRenderState): void {
    const notes = this.#notes;
    if (notes.length === 0) return;

    const { firstIdx, lastIdx } = this.visibleRange(state.nowMs);
    if (firstIdx > lastIdx) return;

    this.#ensureSprites();

    // Pull all hot-loop dependencies into local consts so the JIT can keep
    // them in registers and we never re-read instance state per note.
    const spriteL = this.#spriteL as NoteSprite;
    const spriteR = this.#spriteR as NoteSprite;
    const spOverlay = this.#spOverlay as NoteSprite;
    const sourceL = spriteL.source;
    const sourceR = spriteR.source;
    const sourceSp = spOverlay.source;
    const anchorL = this.#anchorL;
    const anchorR = this.#anchorR;
    const sizeL = this.#sizeL;
    const sizeR = this.#sizeR;
    const anchorSp = this.#anchorSp;
    const sizeSp = this.#sizeSp;

    const travelMs = this.travelMs;
    const nowMs = state.nowMs;
    const hitSet = state.hitNoteIndexes;
    const sp = state.starPowerActive === true;
    const ghostFactor = 1.18;

    ctx.save();

    for (let i = firstIdx; i <= lastIdx; i++) {
      if (hitSet !== undefined && hitSet.has(i)) continue;

      const note = notes[i];
      if (note === undefined) continue;

      const deltaMs = note.tMs - nowMs;
      let p = 1 - deltaMs / travelMs;
      if (p < 0) p = 0;
      else if (p > 1) p = 1;

      const cx = laneCenterX(note.lane, p);
      const cy = progressToY(p);
      const s = scaleAt(p);

      const isL = note.lane === 'L';
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
        ctx.drawImage(
          source,
          dx - ghostOffset,
          dy - ghostOffset,
          ghostSize,
          ghostSize,
        );
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

  /** Lazily build and memoise the lane / SP sprites and their anchor consts. */
  #ensureSprites(): void {
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
}
