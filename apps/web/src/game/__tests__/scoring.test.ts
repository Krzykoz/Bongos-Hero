import { describe, expect, it } from 'vitest';

import type { ChartNote, ChartV1, Judgment } from '@bongos-hero/shared';

import { prepareChart } from '../chart.js';
import { defaultSnapshot, ScoringEngine, type ScoringEvent } from '../scoring.js';

function singleNoteChart(lane: 'L' | 'R' = 'L', tMs = 1000, sp = false): ChartV1 {
  const note: ChartNote = { tMs, lane };
  if (sp) note.sp = true;
  return { version: 1, audioOffsetMs: 0, notes: [note] };
}

function comboChart(count: number): ChartV1 {
  const notes: ChartNote[] = [];
  for (let i = 0; i < count; i++) {
    notes.push({ tMs: 1000 + i * 500, lane: i % 2 === 0 ? 'L' : 'R' });
  }
  return { version: 1, audioOffsetMs: 0, notes };
}

function recordEvents(engine: ScoringEngine): {
  events: ScoringEvent[];
  judgments: Judgment[];
} {
  const events: ScoringEvent[] = [];
  const judgments: Judgment[] = [];
  engine.on((ev) => {
    events.push(ev);
    if (ev.type === 'judgment' && ev.judgment !== undefined) {
      judgments.push(ev.judgment);
    }
  });
  return { events, judgments };
}

describe('ScoringEngine — judgment + combo', () => {
  it('treats a dead-on press as perfect (+50, combo +1)', () => {
    const engine = new ScoringEngine(prepareChart(singleNoteChart('L', 1000), 'hard'));
    const { judgments } = recordEvents(engine);
    engine.pressBongo('L', 1000);
    expect(judgments).toEqual(['perfect']);
    const snap = engine.snapshot();
    expect(snap.score).toBe(50);
    expect(snap.combo).toBe(1);
    expect(snap.hits.perfect).toBe(1);
  });

  it('classifies a 50ms-late press as great', () => {
    const engine = new ScoringEngine(prepareChart(singleNoteChart('L'), 'hard'));
    const { judgments } = recordEvents(engine);
    engine.pressBongo('L', 1050);
    expect(judgments).toEqual(['great']);
  });

  it('classifies a 100ms-late press as good', () => {
    const engine = new ScoringEngine(prepareChart(singleNoteChart('L'), 'hard'));
    const { judgments } = recordEvents(engine);
    engine.pressBongo('L', 1100);
    expect(judgments).toEqual(['good']);
  });

  it('counts a wrong-lane press inside the window as a stray (combo break, no consume)', () => {
    const engine = new ScoringEngine(prepareChart(singleNoteChart('L'), 'hard'));
    const { events, judgments } = recordEvents(engine);
    // Build combo first by hitting a real note from a separate engine isn't applicable;
    // instead, prove the press itself emits a stray and resets combo from any prior state.
    engine.pressBongo('R', 1000); // wrong lane, perfect-window timing
    expect(judgments).toEqual([]); // no judgment was emitted
    expect(events.some((e) => e.type === 'stray' && e.lane === 'R')).toBe(true);
    expect(engine.snapshot().combo).toBe(0);
    // The note was NOT consumed by the wrong-lane press, so it auto-misses on tick.
    engine.tick(2000);
    expect(engine.snapshot().hits.miss).toBe(1);
  });

  it('auto-misses a no-press past the miss window and resets combo to 0', () => {
    // Two notes: hit the first cleanly to build combo=1, then ignore the second.
    const chart: ChartV1 = {
      version: 1,
      audioOffsetMs: 0,
      notes: [
        { tMs: 1000, lane: 'L' },
        { tMs: 2000, lane: 'R' },
      ],
    };
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    const { judgments } = recordEvents(engine);
    engine.pressBongo('L', 1000);
    expect(engine.snapshot().combo).toBe(1);

    engine.tick(2200); // 200 ms past the second note → past 110 ms deadline
    expect(judgments).toEqual(['perfect', 'miss']);
    const snap = engine.snapshot();
    expect(snap.combo).toBe(0);
    expect(snap.hits.miss).toBe(1);
  });
});

describe('ScoringEngine — combo multiplier table', () => {
  it.each([
    { combo: 0, expected: 1 },
    { combo: 9, expected: 1 },
    { combo: 10, expected: 2 },
    { combo: 19, expected: 2 },
    { combo: 20, expected: 3 },
    { combo: 29, expected: 3 },
    { combo: 30, expected: 4 },
    { combo: 99, expected: 4 },
  ])('combo $combo → multiplier $expected', ({ combo, expected }) => {
    // Build up `combo` perfect hits, then check the snapshot's multiplier.
    const chart = comboChart(Math.max(1, combo + 1));
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    for (let i = 0; i < combo; i++) {
      const note = chart.notes[i];
      if (!note) throw new Error('missing note in combo build-up');
      engine.pressBongo(note.lane, note.tMs);
    }
    expect(engine.snapshot().combo).toBe(combo);
    expect(engine.snapshot().multiplier).toBe(expected);
  });

  it('applies the multiplier to the next score award', () => {
    // 11 notes: hit 10 to reach combo=10 (mult=2) then hit the 11th perfect.
    const chart = comboChart(11);
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    for (let i = 0; i < 10; i++) {
      const note = chart.notes[i]!;
      engine.pressBongo(note.lane, note.tMs);
    }
    const before = engine.snapshot().score;
    const last = chart.notes[10]!;
    engine.pressBongo(last.lane, last.tMs);
    // 11th hit at combo=11 → multiplier=2, perfect=50 → +100.
    expect(engine.snapshot().score - before).toBe(100);
  });
});

describe('ScoringEngine — Star Power fill / activation / drain', () => {
  it('adds 0.25 / phrase.length to the meter for perfect hits on sp:true notes', () => {
    // 1 SP-tagged note → phrase length 1 → 0.25 meter for a perfect.
    const chart = singleNoteChart('L', 1000, true);
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    engine.pressBongo('L', 1000);
    expect(engine.snapshot().spMeter).toBeCloseTo(0.25, 9);
  });

  it('adds 0.25 / phrase.length for a great hit on an sp:true note', () => {
    const chart = singleNoteChart('L', 1000, true);
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    engine.pressBongo('L', 1050); // 50 ms late → great
    expect(engine.snapshot().spMeter).toBeCloseTo(0.25, 9);
  });

  it('does NOT add to the meter for a good hit on an sp:true note', () => {
    const chart = singleNoteChart('L', 1000, true);
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    engine.pressBongo('L', 1100); // 100 ms late → good
    expect(engine.snapshot().spMeter).toBe(0);
  });

  it('does NOT add to the meter for a missed sp:true note', () => {
    const chart = singleNoteChart('L', 1000, true);
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    engine.tick(2000); // miss
    expect(engine.snapshot().spMeter).toBe(0);
    expect(engine.snapshot().hits.miss).toBe(1);
  });

  it('refuses to activate Star Power when meter < 0.5', () => {
    const chart = singleNoteChart('L', 1000, true); // perfect → 0.25
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    const { events } = recordEvents(engine);
    engine.pressBongo('L', 1000);
    engine.activateStarPower(1100);
    expect(engine.snapshot().spActive).toBe(false);
    expect(events.some((e) => e.type === 'sp-activated')).toBe(false);
  });

  it('activates when meter ≥ 0.5; while active multiplier is doubled', () => {
    // Two single-note SP phrases (sp + non-sp + sp). Two perfects on sp → meter = 0.5.
    const chart: ChartV1 = {
      version: 1,
      audioOffsetMs: 0,
      notes: [
        { tMs: 1000, lane: 'L', sp: true },
        { tMs: 1500, lane: 'R' }, // breaks the run so the next sp:true starts a new phrase
        { tMs: 2000, lane: 'L', sp: true },
      ],
    };
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    engine.pressBongo('L', 1000);
    engine.pressBongo('R', 1500);
    engine.pressBongo('L', 2000);
    expect(engine.snapshot().spMeter).toBeCloseTo(0.5, 9);

    engine.activateStarPower(2100);
    const snap = engine.snapshot();
    expect(snap.spActive).toBe(true);
    // Combo is 3 → base mult 1 → doubled to 2 while SP active.
    expect(snap.multiplier).toBe(2);
  });

  it('drains the SP meter linearly to empty over 12 000 ms and emits sp-depleted', () => {
    const chart: ChartV1 = {
      version: 1,
      audioOffsetMs: 0,
      notes: [
        { tMs: 1000, lane: 'L', sp: true },
        { tMs: 1500, lane: 'R' },
        { tMs: 2000, lane: 'L', sp: true },
      ],
    };
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    const { events } = recordEvents(engine);
    engine.pressBongo('L', 1000);
    engine.pressBongo('R', 1500);
    engine.pressBongo('L', 2000);
    engine.activateStarPower(2000);
    expect(engine.snapshot().spMeter).toBeCloseTo(0.5, 9);

    // Halfway through the drain (6 000 ms == 0.5 of 12 000 ms): meter = 0.5 - 0.5 = 0.
    // So pick a smaller increment to verify linearity.
    engine.tick(2000 + 3000); // 1/4 drain → meter = 0.5 - 0.25 = 0.25
    expect(engine.snapshot().spMeter).toBeCloseTo(0.25, 6);
    expect(engine.snapshot().spActive).toBe(true);

    engine.tick(2000 + 6000); // full drain (0.5 share over 12000 ms == 6000 ms)
    expect(engine.snapshot().spMeter).toBe(0);
    expect(engine.snapshot().spActive).toBe(false);
    expect(events.some((e) => e.type === 'sp-depleted')).toBe(true);
  });
});

describe('ScoringEngine — rock meter', () => {
  // Build a chart of N notes spaced at distinct deadlines so each can be
  // either hit by a press at its tMs or auto-missed by ticking past it.
  function manyNotesChart(count: number, gapMs = 500): ChartV1 {
    const notes: ChartNote[] = [];
    for (let i = 0; i < count; i++) {
      notes.push({ tMs: 1000 + i * gapMs, lane: i % 2 === 0 ? 'L' : 'R' });
    }
    return { version: 1, audioOffsetMs: 0, notes };
  }

  it('starts at 0.5 with isFailed false', () => {
    const engine = new ScoringEngine(prepareChart(manyNotesChart(1), 'hard'));
    const snap = engine.snapshot();
    expect(snap.rockMeter).toBe(0.5);
    expect(snap.isFailed).toBe(false);
  });

  it.each<{ judgment: 'perfect' | 'great' | 'good'; pressMs: number; delta: number }>([
    { judgment: 'perfect', pressMs: 1000, delta: 0.04 },
    { judgment: 'great', pressMs: 1050, delta: 0.025 },
    { judgment: 'good', pressMs: 1100, delta: 0.01 },
  ])('a $judgment hit moves the meter by +$delta', ({ pressMs, delta }) => {
    const engine = new ScoringEngine(prepareChart(singleNoteChart('L', 1000), 'hard'));
    engine.pressBongo('L', pressMs);
    expect(engine.snapshot().rockMeter).toBeCloseTo(0.5 + delta, 9);
  });

  it('a missed note subtracts 0.10 from the meter', () => {
    const engine = new ScoringEngine(prepareChart(singleNoteChart('L', 1000), 'hard'));
    engine.tick(2000); // past 110 ms deadline → auto-miss
    expect(engine.snapshot().rockMeter).toBeCloseTo(0.4, 9);
    expect(engine.snapshot().hits.miss).toBe(1);
  });

  it('a stray (wrong-lane press inside the window) subtracts 0.04', () => {
    const engine = new ScoringEngine(prepareChart(singleNoteChart('L', 1000), 'hard'));
    engine.pressBongo('R', 1000); // wrong lane → stray
    expect(engine.snapshot().rockMeter).toBeCloseTo(0.46, 9);
  });

  it('clamps at 1.0 even after many perfect hits', () => {
    // Need 13 perfects from 0.5 (13 * 0.04 = 0.52 → would overflow without clamp).
    const chart = manyNotesChart(15);
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    for (const n of chart.notes) engine.pressBongo(n.lane, n.tMs);
    expect(engine.snapshot().rockMeter).toBe(1);
  });

  it('clamps at 0 on repeated misses without going negative', () => {
    // 5 misses from 0.5 → 0; do 7 to verify the clamp absorbs the overshoot.
    const chart = manyNotesChart(7, 200);
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    engine.tick(1000 + 7 * 200 + 200); // tick past every deadline
    expect(engine.snapshot().rockMeter).toBe(0);
    expect(engine.snapshot().hits.miss).toBe(7);
  });

  it('ten consecutive misses (starting from 0.5) trigger isFailed and emit one fail event', () => {
    const chart = manyNotesChart(10, 200);
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    const { events } = recordEvents(engine);

    engine.tick(1000 + 10 * 200 + 200);

    expect(engine.snapshot().isFailed).toBe(true);
    expect(engine.snapshot().rockMeter).toBe(0);
    const failEvents = events.filter((e) => e.type === 'fail');
    expect(failEvents).toHaveLength(1);
  });

  it('does not re-emit fail when later judgments would re-cross zero', () => {
    // Fail the engine first.
    const chart = manyNotesChart(8, 200);
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    const { events } = recordEvents(engine);
    engine.tick(1000 + 8 * 200 + 200);
    expect(events.filter((e) => e.type === 'fail')).toHaveLength(1);
    expect(engine.snapshot().isFailed).toBe(true);

    // Now lift the meter back above zero with a fresh single-note chart,
    // then drop it to zero again. The same engine has already failed though,
    // so we re-prove the no-re-emit guarantee on it: feed a stray (which
    // tries to drain a meter that's already at 0) and confirm no new fail.
    engine.pressBongo('L', 1000 + 8 * 200 + 500); // stray (no notes left)
    expect(events.filter((e) => e.type === 'fail')).toHaveLength(1);
    expect(engine.snapshot().isFailed).toBe(true);
  });

  it('does not change the meter while paused (no judgments tick through)', () => {
    const chart: ChartV1 = {
      version: 1,
      audioOffsetMs: 0,
      notes: [
        { tMs: 1000, lane: 'L' },
        { tMs: 2000, lane: 'R' },
      ],
    };
    const engine = new ScoringEngine(prepareChart(chart, 'hard'));
    engine.pressBongo('L', 1000); // perfect → 0.54
    const beforePause = engine.snapshot().rockMeter;
    expect(beforePause).toBeCloseTo(0.54, 9);

    engine.pause(1100);
    // Try to tick well past the second note's deadline + try a stray press.
    engine.tick(5000);
    engine.pressBongo('R', 5000);
    expect(engine.snapshot().rockMeter).toBe(beforePause);

    // After resume, behavior returns to normal: ticking past the second
    // note's now-shifted deadline auto-misses it and drops the meter.
    engine.resume(5100);
    engine.tick(10000);
    expect(engine.snapshot().rockMeter).toBeCloseTo(beforePause - 0.1, 9);
    expect(engine.snapshot().hits.miss).toBe(1);
  });
});

describe('ScoringEngine — sustain notes', () => {
  function sustainChart(durMs: number, lane: 'L' | 'R' = 'L', tMs = 1000): ChartV1 {
    return {
      version: 1,
      audioOffsetMs: 0,
      notes: [{ tMs, lane, durMs }],
    };
  }

  it('awards the sustain bonus and maintains combo on a clean release at expectedEndMs', () => {
    // L sustain at t=1000, durMs=1000 → expectedEndMs=2000.
    const engine = new ScoringEngine(prepareChart(sustainChart(1000), 'hard'));
    engine.pressBongo('L', 1000); // perfect → +50, opens hold
    engine.releaseBongo('L', 2000); // exactly at expectedEndMs → clean

    const snap = engine.snapshot();
    expect(snap.combo).toBe(1);
    // 50 (perfect) + 100 pts/sec * 1.0 sec * 1× combo mult * 1.0 difficulty = 150.
    expect(snap.score).toBe(150);
    expect(snap.activeHolds).toHaveLength(0);
  });

  it('breaks combo and applies the stray rock-meter penalty on an early release', () => {
    // Press at t=1000, release at 1500 — well before grace window of [1910, ...].
    const engine = new ScoringEngine(prepareChart(sustainChart(1000), 'hard'));
    engine.pressBongo('L', 1000); // perfect → +50, +0.04 rock meter, opens hold
    expect(engine.snapshot().rockMeter).toBeCloseTo(0.54, 9);

    engine.releaseBongo('L', 1500); // early → broken
    const snap = engine.snapshot();
    expect(snap.combo).toBe(0);
    // Rock meter: 0.5 + 0.04 (perfect) - 0.04 (sustain broken) = 0.5.
    expect(snap.rockMeter).toBeCloseTo(0.5, 9);
    // Score is just the perfect — no sustain bonus on break.
    expect(snap.score).toBe(50);
    expect(snap.activeHolds).toHaveLength(0);
  });

  it('emits sustain-broken (with heldMs) and sustain-complete events on the right paths', () => {
    const broken = new ScoringEngine(prepareChart(sustainChart(1000), 'hard'));
    const brokenEvents = recordEvents(broken).events;
    broken.pressBongo('L', 1000);
    broken.releaseBongo('L', 1300);
    const brokenEv = brokenEvents.find((e) => e.type === 'sustain-broken');
    expect(brokenEv).toBeDefined();
    expect(brokenEv?.lane).toBe('L');
    expect(brokenEv?.heldMs).toBeCloseTo(300, 0);

    const clean = new ScoringEngine(prepareChart(sustainChart(1000), 'hard'));
    const cleanEvents = recordEvents(clean).events;
    clean.pressBongo('L', 1000);
    clean.releaseBongo('L', 2000);
    const cleanEv = cleanEvents.find((e) => e.type === 'sustain-complete');
    expect(cleanEv).toBeDefined();
    expect(cleanEv?.heldMs).toBeCloseTo(1000, 0);
  });

  it('auto-closes a never-released hold cleanly when tick crosses expectedEndMs', () => {
    const engine = new ScoringEngine(prepareChart(sustainChart(1000), 'hard'));
    engine.pressBongo('L', 1000);
    engine.tick(2100); // past expectedEndMs (2000)

    const snap = engine.snapshot();
    expect(snap.combo).toBe(1); // never broke
    expect(snap.score).toBe(150); // 50 perfect + 100 * 1.0 sec
    expect(snap.activeHolds).toHaveLength(0);
  });

  it('does not open a hold for the sustain lane on a wrong-lane press', () => {
    // L sustain at t=1000, durMs=1000. No R notes anywhere.
    const engine = new ScoringEngine(prepareChart(sustainChart(1000), 'hard'));
    engine.pressBongo('R', 1000); // wrong lane → stray, NO hold
    let snap = engine.snapshot();
    expect(snap.activeHolds).toHaveLength(0);
    expect(snap.combo).toBe(0);

    // The L note is still hittable until 1000 + 110 = 1110.
    engine.pressBongo('L', 1010); // perfect-window L hit → opens L hold
    snap = engine.snapshot();
    expect(snap.activeHolds).toHaveLength(1);
    expect(snap.activeHolds[0]?.lane).toBe('L');
  });

  it('preserves elapsed accumulatedMs across a pause+resume gap (expectedEndMs shifts too)', () => {
    // Sustain at t=1000, durMs=2000 → expectedEndMs initially 3000.
    const engine = new ScoringEngine(prepareChart(sustainChart(2000), 'hard'));
    engine.pressBongo('L', 1000); // +50, opens hold
    engine.tick(1500); // 500 ms accrued

    expect(engine.snapshot().activeHolds).toHaveLength(1);

    // Pause for 4000 ms of wall-clock (mirroring the rock-meter pause test).
    engine.pause(1500);
    engine.tick(5000); // no-op while paused
    engine.resume(5500); // delta = 4000 → expectedEndMs shifts 3000 → 7000

    // Only 500 ms should accrue here, NOT 4500 ms — pause time is excluded.
    engine.tick(6000);
    let snap = engine.snapshot();
    expect(snap.activeHolds).toHaveLength(1); // not yet at shifted end (7000)

    // Release at the shifted expected end → clean.
    engine.releaseBongo('L', 7000);
    snap = engine.snapshot();
    expect(snap.activeHolds).toHaveLength(0);
    expect(snap.combo).toBe(1); // maintained
    // Total accrued = 500 (pre-pause) + 1500 (post-resume to expectedEndMs) = 2000 ms.
    // Sustain points: 100 * (2000/1000) = 200. Plus 50 perfect = 250.
    expect(snap.score).toBe(250);
  });

  it('snapshot.activeHolds is the same array reference across calls (no per-frame allocation)', () => {
    const engine = new ScoringEngine(prepareChart(sustainChart(1000), 'hard'));
    engine.pressBongo('L', 1000);
    const a = engine.snapshot().activeHolds;
    const b = engine.snapshot().activeHolds;
    expect(a).toBe(b);
  });
});

describe('defaultSnapshot', () => {
  it('returns the canonical zero-state shape', () => {
    const snap = defaultSnapshot();
    expect(snap.score).toBe(0);
    expect(snap.combo).toBe(0);
    expect(snap.maxCombo).toBe(0);
    expect(snap.multiplier).toBe(1);
    expect(snap.spMeter).toBe(0);
    expect(snap.spActive).toBe(false);
    expect(snap.spRemainingMs).toBe(0);
    expect(snap.hits).toEqual({ perfect: 0, great: 0, good: 0, miss: 0 });
    expect(snap.consumed).toBeInstanceOf(Set);
    expect(snap.consumed.size).toBe(0);
    expect(snap.notesPlayed).toBe(0);
    expect(snap.notesTotal).toBe(0);
    expect(snap.rockMeter).toBe(0.5);
    expect(snap.isFailed).toBe(false);
    expect(snap.activeHolds).toEqual([]);
  });

  it('returns a fresh object each call (mutating one does not affect the next)', () => {
    const a = defaultSnapshot();
    (a.activeHolds as { lane: 'L' | 'R'; remainingMs: number }[]).push({
      lane: 'L',
      remainingMs: 999,
    });
    (a.consumed as Set<number>).add(7);
    a.hits.perfect = 42;

    const b = defaultSnapshot();
    expect(b.activeHolds).toEqual([]);
    expect(b.consumed.size).toBe(0);
    expect(b.hits).toEqual({ perfect: 0, great: 0, good: 0, miss: 0 });
  });

  it('covers every key in ScoringSnapshot', () => {
    const expected = [
      'score',
      'combo',
      'maxCombo',
      'multiplier',
      'spMeter',
      'spActive',
      'spRemainingMs',
      'hits',
      'consumed',
      'notesPlayed',
      'notesTotal',
      'rockMeter',
      'isFailed',
      'activeHolds',
    ] as const;
    const snap = defaultSnapshot();
    for (const k of expected) {
      expect(snap).toHaveProperty(k);
    }
    expect(Object.keys(snap).sort()).toEqual([...expected].sort());
  });
});
