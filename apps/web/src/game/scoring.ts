/**
 * Scoring engine for Bongos Hero.
 *
 * Handles judgment windows, combo/multiplier, Star-Power meter fill and
 * drain, sustain-note hold sessions, and emits structured events for the
 * HUD/SFX layer to react to.
 *
 * Hot-path methods (`tick`, `pressBongo`) are designed to be allocation-
 * free in the steady state: the only objects created per call are the
 * (unavoidable) `ScoringEvent` instances passed to subscribers, and only
 * when something interesting actually happens.
 */

import type { ChartNote, Lane, Judgment } from '@bongos-hero/shared';
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

/** Starting level for the rock meter (Guitar-Hero-style fail bar). */
const ROCK_METER_START = 0.5;

/**
 * Per-judgment delta applied to the rock meter on each resolution.
 * Positive entries refill, negative entries drain. The meter is clamped
 * to [0, 1] after every adjustment and a `'fail'` event fires the first
 * time it touches zero.
 */
const ROCK_METER_DELTA = {
  perfect: 0.04,
  great: 0.025,
  good: 0.01,
  miss: -0.1,
  /** Wrong-lane press inside the hit window. Also used for early sustain release. */
  stray: -0.04,
} as const;

/**
 * Window before a sustain's `expectedEndMs` in which a release still counts as
 * a clean completion. Mirrors human reaction-time slack on a key-up.
 */
const SUSTAIN_GRACE_MS = 90;

/** Score points awarded per second of cleanly-held sustain (pre-multipliers). */
const SUSTAIN_SCORE_PER_SEC = 100;

/**
 * Active "hold session" for a sustain note. One per lane at most. Created
 * on the press that resolves the sustain note; destroyed by `releaseBongo`
 * (player let go) or by `tick` reaching `expectedEndMs` (player held long
 * enough). Reads of `accumulatedMs` always see time the player ACTUALLY
 * had the lane key down — pause time and time after `expectedEndMs` do
 * not contribute.
 */
interface HoldSession {
  noteIdx: number;
  lane: Lane;
  /** `nowMs` of the press that opened the session. */
  startedAtMs: number;
  /** `adjusted[noteIdx] + note.durMs` at open time; shifted by pause delta on resume. */
  expectedEndMs: number;
  /** Latest `nowMs` whose elapsed time has been folded into `accumulatedMs`. */
  lastTickMs: number;
  /** Held-time the player has accrued so far. Capped at `durMs` by the close logic. */
  accumulatedMs: number;
  /** Latched true if the player released early. Useful for telemetry / SFX. */
  broken: boolean;
}

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
  /** Guitar-Hero-style rock meter, 0..1, starts at 0.5. Empty = song fail. */
  rockMeter: number;
  /** True once the rock meter has hit 0; latched, never cleared. */
  isFailed: boolean;
  /**
   * Currently-held sustains. The renderer reads this to decide which trails
   * to paint as "actively held" (brighter tint).
   *
   * **Caller contract:** the returned array and its element objects are
   * mutable buffers reused across snapshots. Read fields immediately; never
   * cache the array, the elements, or any field across frames.
   */
  activeHolds: readonly { readonly lane: Lane; readonly remainingMs: number }[];
}

/**
 * Returns a fresh, all-defaults `ScoringSnapshot`. Used by:
 * - the HUD demo to render a "no game in progress" state, and
 * - tests that need a baseline snapshot to spread overrides onto.
 *
 * Numeric fields are 0 except `rockMeter` (0.5 = neutral starting bar) and
 * `multiplier` (1× — the combo table's lowest tier). All collection fields
 * are constructed fresh on each call so callers may safely mutate the
 * result; this helper is **not** in the per-frame draw path.
 */
export function defaultSnapshot(): ScoringSnapshot {
  return {
    score: 0,
    combo: 0,
    maxCombo: 0,
    multiplier: 1,
    spMeter: 0,
    spActive: false,
    spRemainingMs: 0,
    hits: { perfect: 0, great: 0, good: 0, miss: 0 },
    consumed: new Set<number>(),
    notesPlayed: 0,
    notesTotal: 0,
    rockMeter: ROCK_METER_START,
    isFailed: false,
    activeHolds: [],
  };
}

export interface ScoringEvent {
  type:
    | 'judgment'
    | 'stray'
    | 'sp-activated'
    | 'sp-depleted'
    | 'phrase-complete'
    | 'fail'
    | 'sustain-complete'
    | 'sustain-broken';
  judgment?: Judgment;
  lane?: Lane;
  /** For 'judgment' on a real note. */
  noteIndex?: number;
  /** Timing delta in ms (signed: negative = early, positive = late). */
  deltaMs?: number;
  /** SP fill amount added (0..1) for 'phrase-complete'. */
  spDelta?: number;
  /** Held-time in ms accrued for 'sustain-complete' / 'sustain-broken'. */
  heldMs?: number;
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

  // Rock meter (Guitar-Hero-style fail bar).
  private _rockMeter = ROCK_METER_START;
  private _isFailed = false;

  // Active sustain holds — at most one per lane.
  private _holdL: HoldSession | null = null;
  private _holdR: HoldSession | null = null;

  // Stable buffers for `snapshot().activeHolds` so per-frame snapshots don't
  // allocate. `_holdSlots[0]` is for L, `[1]` for R; mutated in place each
  // call to `snapshot()`. `_holdsView` is rebuilt by clearing length to 0 and
  // pushing the active slots; in steady state this never grows the array.
  private readonly _holdSlots = [
    { lane: 'L' as Lane, remainingMs: 0 },
    { lane: 'R' as Lane, remainingMs: 0 },
  ];
  private readonly _holdsView: { lane: Lane; remainingMs: number }[] = [];

  /**
   * Monotonic clamp for the tick clock. We never re-judge already-resolved
   * notes, so a backwards-going `nowMs` (e.g. clock jitter / debug seek)
   * just freezes the auto-miss + SP-drain side effects until the clock
   * catches back up.
   */
  private _lastTickMs = -Infinity;

  /**
   * Set by `pause(nowMs)`, cleared by `resume(nowMs)`. While non-null,
   * `tick` / `pressBongo` / `releaseBongo` / `activateStarPower` are no-ops,
   * so the engine snapshot freezes (no auto-miss, no SP drain, no judging,
   * no hold-time accrual) until resume. On resume we shift any active
   * SP-activation timestamp AND every active hold's `lastTickMs` and
   * `expectedEndMs` forward by the paused duration so SP duration and
   * sustain end-times are preserved across the gap, regardless of whether
   * the master clock is song-time or wall-clock anchored.
   */
  private _pausedAtMs: number | null = null;

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
    if (this._pausedAtMs !== null) return;
    const clamped = nowMs < this._lastTickMs ? this._lastTickMs : nowMs;
    this._lastTickMs = clamped;

    this._autoMissUpTo(clamped);
    this._drainSp(clamped);
    this._tickHolds(clamped);
  }

  /** Process a bongo press. Internally calls `tick(nowMs)` first for safety. */
  pressBongo(lane: Lane, nowMs: number): void {
    if (this._pausedAtMs !== null) return;
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

      // If the note we just resolved is a sustain, open a hold session for
      // its lane. A 'miss' classification means we never actually hit it
      // (the press timing was a miss-equivalent), so don't open a hold.
      if (judgment !== 'miss') {
        const note = notes[bestSameIdx];
        const durMs = note?.durMs ?? 0;
        if (note !== undefined && durMs > 0) {
          this._openHold(bestSameIdx, lane, nowMs, note);
        }
      }
      return;
    }

    // No same-lane note in range — this press is a "stray" (either truly
    // empty window, or a wrong-lane press). Either way: combo break, no
    // note consumed, and we tag the event with the lane that was struck.
    void bestOppIdx; // currently unused but useful for future "wrong lane" telemetry
    this._stray(lane, nowMs);
  }

  /**
   * Process a key-up for the given lane. Closes any active hold session
   * for that lane (clean if at/past `expectedEndMs - SUSTAIN_GRACE_MS`,
   * broken otherwise). No-op when no hold is active for the lane, or when
   * the engine is paused. Safe to call any number of times; the first call
   * with an active hold consumes it and subsequent calls are no-ops until
   * the next press opens a new hold.
   */
  releaseBongo(lane: Lane, nowMs: number): void {
    if (this._pausedAtMs !== null) return;
    this.tick(nowMs);
    const hold = lane === 'L' ? this._holdL : this._holdR;
    if (hold === null) return;
    this._closeHold(hold, nowMs);
  }

  /** Activate Star-Power if the meter is at least 50%. No-op otherwise. */
  activateStarPower(nowMs: number): void {
    if (this._pausedAtMs !== null) return;
    this.tick(nowMs);
    if (this._spActive) return;
    if (this._spMeter < SP_ACTIVATION_THRESHOLD) return;

    this._spActive = true;
    this._spStartedAtMs = nowMs;
    this._spMeterAtActivation = this._spMeter;

    this._emit({ type: 'sp-activated', tMs: nowMs });
  }

  /**
   * Snapshot the engine for a play-scene pause. Flushes any pending
   * auto-miss / SP drain up to `nowMs`, then locks the engine: subsequent
   * `tick` / `pressBongo` / `activateStarPower` calls are no-ops, and the
   * snapshot reads stay frozen until `resume(...)`. Idempotent.
   */
  pause(nowMs: number): void {
    if (this._pausedAtMs !== null) return;
    this.tick(nowMs);
    this._pausedAtMs = nowMs;
  }

  /**
   * Resume from a previous `pause(...)`. Shifts the SP activation timestamp
   * (and the monotonic tick watermark) forward by the paused duration so
   * Star-Power duration is preserved across the gap. Safe to call when not
   * paused (no-op).
   */
  resume(nowMs: number): void {
    if (this._pausedAtMs === null) return;
    const delta = nowMs - this._pausedAtMs;
    this._pausedAtMs = null;
    if (delta <= 0) return;
    if (this._spActive) this._spStartedAtMs += delta;
    if (this._lastTickMs !== -Infinity) this._lastTickMs += delta;
    // Mirror the SP-freeze pattern for sustain holds: shift the hold's
    // monotonic clock AND its expected end so the player isn't penalised
    // for a key they couldn't have released while the engine was paused.
    if (this._holdL !== null) {
      this._holdL.lastTickMs += delta;
      this._holdL.expectedEndMs += delta;
    }
    if (this._holdR !== null) {
      this._holdR.lastTickMs += delta;
      this._holdR.expectedEndMs += delta;
    }
  }

  /** Read-only HUD/renderer snapshot. Allocates one fresh object per call. */
  snapshot(): ScoringSnapshot {
    const baseMul = baseMultiplierForCombo(this._combo);
    const mul = this._spActive ? baseMul * 2 : baseMul;
    const remaining = this._spActive ? this._spMeter * SP_DURATION_MS : 0;

    // Rebuild the activeHolds buffer in place. Length-zero + push reuses the
    // backing storage in steady state (after the first frame the array
    // capacity stabilises at ≤2). The slot objects are also reused across
    // frames to avoid per-frame `{ lane, remainingMs }` allocation.
    this._holdsView.length = 0;
    const lastTick = this._lastTickMs === -Infinity ? 0 : this._lastTickMs;
    if (this._holdL !== null) {
      const slot = this._holdSlots[0]!;
      slot.lane = 'L';
      slot.remainingMs = Math.max(0, this._holdL.expectedEndMs - lastTick);
      this._holdsView.push(slot);
    }
    if (this._holdR !== null) {
      const slot = this._holdSlots[1]!;
      slot.lane = 'R';
      slot.remainingMs = Math.max(0, this._holdR.expectedEndMs - lastTick);
      this._holdsView.push(slot);
    }

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
      rockMeter: this._rockMeter,
      isFailed: this._isFailed,
      activeHolds: this._holdsView,
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
      this._adjustRockMeter(ROCK_METER_DELTA.miss, nowMs);
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

      this._adjustRockMeter(ROCK_METER_DELTA[judgment], nowMs);

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
    this._adjustRockMeter(ROCK_METER_DELTA.stray, nowMs);
    this._emit({ type: 'stray', lane, tMs: nowMs });
  }

  /**
   * Open a sustain hold session for `lane`. If a hold already exists for the
   * lane (player double-pressed), the existing one is closed first using the
   * current rules — typically that means broken (combo reset, rock penalty),
   * since the new press almost always lands well before the previous hold's
   * `expectedEndMs`.
   */
  private _openHold(noteIdx: number, lane: Lane, nowMs: number, note: ChartNote): void {
    const existing = lane === 'L' ? this._holdL : this._holdR;
    if (existing !== null) this._closeHold(existing, nowMs);

    const adjusted = this.prepared.noteTimesAdjustedMs[noteIdx] ?? note.tMs;
    const durMs = note.durMs ?? 0;
    const hold: HoldSession = {
      noteIdx,
      lane,
      startedAtMs: nowMs,
      expectedEndMs: adjusted + durMs,
      lastTickMs: nowMs,
      accumulatedMs: 0,
      broken: false,
    };
    if (lane === 'L') this._holdL = hold;
    else this._holdR = hold;
  }

  /**
   * Per-tick maintenance of any active hold sessions. For each open hold:
   *   - if `nowMs >= expectedEndMs`, auto-close as a clean completion (the
   *     player held long enough; they get full credit even without a release).
   *   - otherwise accrue `(nowMs - lastTickMs)` into `accumulatedMs` and
   *     advance `lastTickMs`.
   */
  private _tickHolds(nowMs: number): void {
    if (this._holdL !== null) {
      if (nowMs >= this._holdL.expectedEndMs) {
        this._closeHold(this._holdL, nowMs);
      } else if (nowMs > this._holdL.lastTickMs) {
        this._holdL.accumulatedMs += nowMs - this._holdL.lastTickMs;
        this._holdL.lastTickMs = nowMs;
      }
    }
    if (this._holdR !== null) {
      if (nowMs >= this._holdR.expectedEndMs) {
        this._closeHold(this._holdR, nowMs);
      } else if (nowMs > this._holdR.lastTickMs) {
        this._holdR.accumulatedMs += nowMs - this._holdR.lastTickMs;
        this._holdR.lastTickMs = nowMs;
      }
    }
  }

  /**
   * Close an open hold session at `nowMs`. Shared between the explicit
   * release path, the tick auto-close path, and the open-while-already-held
   * defence in `_openHold`. Idempotent on the active-hold slot pointer
   * (clears it after running).
   *
   * Award rules:
   *   - clean (`nowMs >= expectedEndMs - SUSTAIN_GRACE_MS`): combo is
   *     maintained; score += round(100 * heldSec * comboMul * spMul *
   *     difficultyMul). SP fill is unchanged (sustain credit is independent
   *     of the SP-phrase share system).
   *   - broken (early release): combo → 0; rock meter takes the same hit as
   *     a stray press (-0.04). The player still keeps any score awarded
   *     for the original `pressBongo` judgment — they just forfeit the
   *     sustain bonus and the streak.
   */
  private _closeHold(hold: HoldSession, nowMs: number): void {
    // Cap accrual at expectedEndMs even if the player held past it. Time
    // beyond the note's `durMs` is not worth more points.
    const cap = nowMs < hold.expectedEndMs ? nowMs : hold.expectedEndMs;
    if (cap > hold.lastTickMs) {
      hold.accumulatedMs += cap - hold.lastTickMs;
      hold.lastTickMs = cap;
    }

    const isClean = nowMs >= hold.expectedEndMs - SUSTAIN_GRACE_MS;

    if (isClean) {
      const baseMul = baseMultiplierForCombo(this._combo);
      const mul = this._spActive ? baseMul * 2 : baseMul;
      const points = Math.round(
        SUSTAIN_SCORE_PER_SEC *
          (hold.accumulatedMs / 1000) *
          mul *
          this.prepared.difficultyMultiplier,
      );
      this._score += points;
      this._emit({
        type: 'sustain-complete',
        lane: hold.lane,
        noteIndex: hold.noteIdx,
        heldMs: hold.accumulatedMs,
        tMs: nowMs,
      });
    } else {
      hold.broken = true;
      this._combo = 0;
      this._adjustRockMeter(ROCK_METER_DELTA.stray, nowMs);
      this._emit({
        type: 'sustain-broken',
        lane: hold.lane,
        noteIndex: hold.noteIdx,
        heldMs: hold.accumulatedMs,
        tMs: nowMs,
      });
    }

    if (hold.lane === 'L') this._holdL = null;
    else this._holdR = null;
  }

  /**
   * Apply a delta to the rock meter, clamped into [0, 1]. The first time
   * the meter falls from a positive value to zero, latch `_isFailed` and
   * emit a one-shot `'fail'` event. Once failed we never re-emit, even if
   * subsequent hits temporarily refill the meter and another miss drops
   * it back to zero.
   */
  private _adjustRockMeter(delta: number, nowMs: number): void {
    const prev = this._rockMeter;
    let next = prev + delta;
    if (next < 0) next = 0;
    else if (next > 1) next = 1;
    this._rockMeter = next;

    if (!this._isFailed && next === 0 && prev > 0) {
      this._isFailed = true;
      this._emit({ type: 'fail', tMs: nowMs });
    }
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
