/**
 * Scoring engine for Bongos Hero.
 *
 * Handles judgment windows, combo/multiplier, Star-Power meter fill and
 * drain, and emits structured events for the HUD/SFX layer to react to.
 *
 * Hot-path methods (`tick`, `pressBongo`) are designed to be allocation-
 * free in the steady state: the only objects created per call are the
 * (unavoidable) `ScoringEvent` instances passed to subscribers, and only
 * when something interesting actually happens.
 */

import type { Lane, Judgment } from '@bongos-hero/shared';
import { JUDGMENT_SCORE, JUDGMENT_WINDOW_MS } from '@bongos-hero/shared';

import type { PreparedChart } from './chart.js';

/** Maximum absolute timing delta (ms) at which a press can still hit a note. */
const MAX_HIT_WINDOW_MS = JUDGMENT_WINDOW_MS.good; // 110

/** Total time (ms) it takes a full Star-Power meter to drain. */
const SP_DURATION_MS = 12_000;

/** Star-Power meter level required to activate. */
const SP_ACTIVATION_THRESHOLD = 0.5;

/** Total share of the SP meter awarded for cleanly completing one phrase. */
const SP_PHRASE_FILL = 0.25;

export interface ScoringSnapshot {
  score: number;
  combo: number;
  maxCombo: number;
  /** 1, 2, 3, or 4 from the combo table, doubled while SP is active. */
  multiplier: number;
  /** 0..1. */
  spMeter: number;
  spActive: boolean;
  /** ms of SP time left if active, else 0. */
  spRemainingMs: number;
  hits: { perfect: number; great: number; good: number; miss: number };
  /** Indexes of notes already consumed (for the renderer to skip). */
  consumed: ReadonlySet<number>;
  /** Count of consumed notes (any judgment, including misses). */
  notesPlayed: number;
  notesTotal: number;
}

export interface ScoringEvent {
  type: 'judgment' | 'stray' | 'sp-activated' | 'sp-depleted' | 'phrase-complete';
  judgment?: Judgment;
  lane?: Lane;
  /** For 'judgment' on a real note. */
  noteIndex?: number;
  /** Timing delta in ms (signed: negative = early, positive = late). */
  deltaMs?: number;
  /** SP fill amount added (0..1) for 'phrase-complete'. */
  spDelta?: number;
  /** Song time when the event fired. */
  tMs: number;
}

type Listener = (ev: ScoringEvent) => void;

export class ScoringEngine {
  /** Same set, mutated in place across frames — pass to NotesRenderer. */
  readonly consumedSet: ReadonlySet<number>;

  private readonly prepared: PreparedChart;
  private readonly listeners = new Set<Listener>();

  // Internally we hold the mutable Set; the public alias is read-only typed.
  private readonly _consumed = new Set<number>();

  /** Counters / running totals. */
  private _score = 0;
  private _combo = 0;
  private _maxCombo = 0;
  private _hitsPerfect = 0;
  private _hitsGreat = 0;
  private _hitsGood = 0;
  private _hitsMiss = 0;
  private _notesPlayed = 0;

  /**
   * Cursor: the smallest index that has not yet been auto-miss-checked.
   * `tick` advances it forward as deadlines pass; `pressBongo` only reads it.
   * All notes with index < _nextPendingIdx are guaranteed to be in
   * `_consumed` (either as a real hit or as an auto-miss).
   */
  private _nextPendingIdx = 0;

  /** Per-phrase share counters for partial-credit tracking and events. */
  private readonly _phraseShareEarned: number[];
  private readonly _phraseNotesResolved: number[];

  // Star Power state.
  private _spMeter = 0;
  private _spActive = false;
  private _spStartedAtMs = 0;
  /**
   * Snapshot of the meter at activation, plus any fills added since,
   * minus nothing (drain is computed on demand from `_spStartedAtMs`).
   * See `_recomputeSpWhileActive`.
   */
  private _spMeterAtActivation = 0;

  /**
   * Monotonic clamp for the tick clock. We never re-judge already-resolved
   * notes, so a backwards-going `nowMs` (e.g. clock jitter / debug seek)
   * just freezes the auto-miss + SP-drain side effects until the clock
   * catches back up.
   */
  private _lastTickMs = -Infinity;

  constructor(prepared: PreparedChart) {
    this.prepared = prepared;
    this.consumedSet = this._consumed;
    this._phraseShareEarned = new Array<number>(prepared.phrases.length).fill(0);
    this._phraseNotesResolved = new Array<number>(prepared.phrases.length).fill(0);
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /** Subscribe to events. Returns an unsubscribe function. */
  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return (): void => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Advance the auto-miss clock + SP drain to `nowMs`. Idempotent. Safe
   * to call multiple times per frame.
   *
   * If `nowMs` regresses below the previous tick, we clamp to the previous
   * value. We never un-resolve a note or refill the SP meter.
   */
  tick(nowMs: number): void {
    const clamped = nowMs < this._lastTickMs ? this._lastTickMs : nowMs;
    this._lastTickMs = clamped;

    this._autoMissUpTo(clamped);
    this._drainSp(clamped);
  }

  /** Process a bongo press. Internally calls `tick(nowMs)` first for safety. */
  pressBongo(lane: Lane, nowMs: number): void {
    this.tick(nowMs);

    const adjusted = this.prepared.noteTimesAdjustedMs;
    const notes = this.prepared.playableChart.notes;
    const total = this.prepared.totalNotes;

    let bestSameIdx = -1;
    let bestSameAbs = Number.POSITIVE_INFINITY;
    let bestSameDelta = 0;

    let bestOppIdx = -1;
    let bestOppAbs = Number.POSITIVE_INFINITY;

    // Walk forward from the cursor while notes are within (or before) the
    // hit window. Notes with adjusted - now > 110 are too far in the future
    // to be hittable; everything before that has either already been
    // consumed or is in the live ±110 window.
    for (let i = this._nextPendingIdx; i < total; i++) {
      const adjT = adjusted[i];
      if (adjT === undefined) continue;
      const delta = adjT - nowMs;
      if (delta > MAX_HIT_WINDOW_MS) break;
      if (this._consumed.has(i)) continue;
      const abs = delta < 0 ? -delta : delta;
      if (abs > MAX_HIT_WINDOW_MS) continue;

      const note = notes[i];
      if (note === undefined) continue;

      if (note.lane === lane) {
        if (abs < bestSameAbs) {
          bestSameAbs = abs;
          bestSameIdx = i;
          bestSameDelta = delta;
        }
      } else {
        if (abs < bestOppAbs) {
          bestOppAbs = abs;
          bestOppIdx = i;
        }
      }
    }

    if (bestSameIdx >= 0) {
      const judgment = this._classify(bestSameAbs);
      this._resolveNote(bestSameIdx, judgment, bestSameDelta, nowMs);
      return;
    }

    // No same-lane note in range — this press is a "stray" (either truly
    // empty window, or a wrong-lane press). Either way: combo break, no
    // note consumed, and we tag the event with the lane that was struck.
    void bestOppIdx; // currently unused but useful for future "wrong lane" telemetry
    this._stray(lane, nowMs);
  }

  /** Activate Star-Power if the meter is at least 50%. No-op otherwise. */
  activateStarPower(nowMs: number): void {
    this.tick(nowMs);
    if (this._spActive) return;
    if (this._spMeter < SP_ACTIVATION_THRESHOLD) return;

    this._spActive = true;
    this._spStartedAtMs = nowMs;
    this._spMeterAtActivation = this._spMeter;

    this._emit({ type: 'sp-activated', tMs: nowMs });
  }

  /** Read-only HUD/renderer snapshot. Allocates one fresh object per call. */
  snapshot(): ScoringSnapshot {
    const baseMul = baseMultiplierForCombo(this._combo);
    const mul = this._spActive ? baseMul * 2 : baseMul;
    const remaining = this._spActive ? this._spMeter * SP_DURATION_MS : 0;

    return {
      score: this._score,
      combo: this._combo,
      maxCombo: this._maxCombo,
      multiplier: mul,
      spMeter: this._spMeter,
      spActive: this._spActive,
      spRemainingMs: remaining,
      hits: {
        perfect: this._hitsPerfect,
        great: this._hitsGreat,
        good: this._hitsGood,
        miss: this._hitsMiss,
      },
      consumed: this._consumed,
      notesPlayed: this._notesPlayed,
      notesTotal: this.prepared.totalNotes,
    };
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Walk the auto-miss cursor forward, marking any note whose deadline
   * (`adjusted + 110ms`) has elapsed and which wasn't consumed by a
   * press as a miss.
   */
  private _autoMissUpTo(nowMs: number): void {
    const adjusted = this.prepared.noteTimesAdjustedMs;
    const total = this.prepared.totalNotes;

    while (this._nextPendingIdx < total) {
      const i = this._nextPendingIdx;
      const adjT = adjusted[i];
      if (adjT === undefined) {
        this._nextPendingIdx++;
        continue;
      }
      // While the deadline is still in the future (or exactly at now), stop.
      if (adjT + MAX_HIT_WINDOW_MS >= nowMs) break;

      if (!this._consumed.has(i)) {
        // Auto-miss. Use a synthetic "late by exactly the deadline" delta;
        // the exact value isn't observed by gameplay, only telemetry.
        this._resolveNote(i, 'miss', nowMs - adjT, nowMs);
      }
      this._nextPendingIdx++;
    }
  }

  /** Update SP drain while active. Deactivates and emits when meter hits 0. */
  private _drainSp(nowMs: number): void {
    if (!this._spActive) return;

    const elapsed = nowMs - this._spStartedAtMs;
    const drained = elapsed / SP_DURATION_MS;
    let next = this._spMeterAtActivation - drained;

    if (next <= 0) {
      this._spMeter = 0;
      this._spActive = false;
      this._spMeterAtActivation = 0;
      this._spStartedAtMs = 0;
      this._emit({ type: 'sp-depleted', tMs: nowMs });
      return;
    }

    if (next > 1) next = 1;
    this._spMeter = next;
  }

  /**
   * Resolve a note (hit or auto-miss): mark consumed, update score / combo /
   * SP fill, emit `judgment` event, and emit `phrase-complete` if this was
   * the last note of an SP phrase.
   */
  private _resolveNote(noteIdx: number, judgment: Judgment, deltaMs: number, nowMs: number): void {
    if (this._consumed.has(noteIdx)) return; // defence; should not happen
    this._consumed.add(noteIdx);
    this._notesPlayed++;

    const notes = this.prepared.playableChart.notes;
    const note = notes[noteIdx];
    const lane: Lane | undefined = note?.lane;

    if (judgment === 'miss') {
      this._hitsMiss++;
      this._combo = 0;
    } else {
      if (judgment === 'perfect') this._hitsPerfect++;
      else if (judgment === 'great') this._hitsGreat++;
      else this._hitsGood++;

      this._combo++;
      if (this._combo > this._maxCombo) this._maxCombo = this._combo;

      const baseMul = baseMultiplierForCombo(this._combo);
      const mul = this._spActive ? baseMul * 2 : baseMul;
      // Round each award so `_score` is always an integer and the HUD never
      // shows "1234.55" (and so the results screen and HUD never disagree).
      this._score += Math.round(
        JUDGMENT_SCORE[judgment] * mul * this.prepared.difficultyMultiplier,
      );

      // SP fill: only "clean" judgments (perfect/great) contribute; good/miss don't.
      if (judgment === 'perfect' || judgment === 'great') {
        const pid = this.prepared.phraseId[noteIdx];
        if (pid !== undefined && pid >= 0) {
          const phrase = this.prepared.phrases[pid];
          if (phrase !== undefined && phrase.length > 0) {
            const share = SP_PHRASE_FILL / phrase.length;
            this._addSpFill(share, nowMs);
            const earned = this._phraseShareEarned[pid] ?? 0;
            this._phraseShareEarned[pid] = earned + share;
          }
        }
      }
    }

    // Track phrase completion: a phrase is "complete" once every one of
    // its notes has been resolved (hit or missed). Emit one event then.
    const pid = this.prepared.phraseId[noteIdx];
    if (pid !== undefined && pid >= 0) {
      const phrase = this.prepared.phrases[pid];
      if (phrase !== undefined) {
        const resolved = (this._phraseNotesResolved[pid] ?? 0) + 1;
        this._phraseNotesResolved[pid] = resolved;
        if (resolved === phrase.length) {
          this._emit({
            type: 'phrase-complete',
            tMs: nowMs,
            spDelta: this._phraseShareEarned[pid] ?? 0,
          });
        }
      }
    }

    const ev: ScoringEvent = {
      type: 'judgment',
      judgment,
      noteIndex: noteIdx,
      deltaMs,
      tMs: nowMs,
    };
    if (lane !== undefined) ev.lane = lane;
    this._emit(ev);
  }

  /** Add a fresh SP fill, correctly stacking onto an active drain. */
  private _addSpFill(share: number, nowMs: number): void {
    if (share <= 0) return;

    if (this._spActive) {
      const drained = (nowMs - this._spStartedAtMs) / SP_DURATION_MS;
      let effective = this._spMeterAtActivation - drained;
      if (effective < 0) effective = 0;
      effective += share;
      if (effective > 1) effective = 1;
      this._spMeter = effective;
      // Reset the drain origin so future drains continue from the new level.
      this._spMeterAtActivation = effective + drained;
    } else {
      let next = this._spMeter + share;
      if (next > 1) next = 1;
      this._spMeter = next;
    }
  }

  /** Emit a stray-press event and reset combo. Does not consume any note. */
  private _stray(lane: Lane, nowMs: number): void {
    this._combo = 0;
    this._emit({ type: 'stray', lane, tMs: nowMs });
  }

  /** Map an absolute timing delta to a judgment. */
  private _classify(absDelta: number): Judgment {
    if (absDelta <= JUDGMENT_WINDOW_MS.perfect) return 'perfect';
    if (absDelta <= JUDGMENT_WINDOW_MS.great) return 'great';
    if (absDelta <= JUDGMENT_WINDOW_MS.good) return 'good';
    return 'miss';
  }

  private _emit(ev: ScoringEvent): void {
    for (const cb of this.listeners) cb(ev);
  }
}

/** Pure mapping from combo count to base multiplier. */
function baseMultiplierForCombo(combo: number): number {
  if (combo >= 30) return 4;
  if (combo >= 20) return 3;
  if (combo >= 10) return 2;
  return 1;
}
