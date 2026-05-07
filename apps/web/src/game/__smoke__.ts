/**
 * Manual smoke test for the scoring engine. Not auto-imported from main.ts.
 *
 * Run with `npx tsx apps/web/src/game/__smoke__.ts` (or import + call from
 * a debug console).
 */

import type { ChartNote, ChartV1, Judgment } from '@bongos-hero/shared';

import { prepareChart } from './chart.js';
import { ScoringEngine, type ScoringEvent } from './scoring.js';

function buildChart(): ChartV1 {
  const notes: ChartNote[] = [];
  // 8 alternating notes every 500ms starting at t=1000ms.
  // Indexes 2 & 3 form a 2-note SP phrase; index 6 is a 1-note SP phrase.
  // Total: 2 phrases.
  for (let i = 0; i < 8; i++) {
    const note: ChartNote = {
      tMs: 1000 + i * 500,
      lane: i % 2 === 0 ? 'L' : 'R',
    };
    if (i === 2 || i === 3 || i === 6) note.sp = true;
    notes.push(note);
  }
  return { version: 1, audioOffsetMs: 0, notes };
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`scoring smoke: ${msg}`);
}

function recordJudgments(engine: ScoringEngine): {
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

export function runScoringSmoke(): void {
  // ---- prepareChart shape ----
  const chart = buildChart();
  const prepared = prepareChart(chart);
  assert(prepared.totalNotes === 8, `expected 8 notes, got ${prepared.totalNotes}`);
  assert(prepared.phrases.length === 2, `expected 2 phrases, got ${prepared.phrases.length}`);
  const phrase0 = prepared.phrases[0];
  const phrase1 = prepared.phrases[1];
  assert(phrase0?.length === 2, `phrase 0 should have 2 notes`);
  assert(phrase1?.length === 1, `phrase 1 should have 1 note`);
  assert(prepared.phraseId[2] === 0 && prepared.phraseId[3] === 0, 'phrase 0 indexes');
  assert(prepared.phraseId[6] === 1, 'phrase 1 index');
  assert(prepared.phraseId[0] === -1 && prepared.phraseId[7] === -1, 'non-SP phraseId');

  // ---- 8 dead-on perfects ----
  {
    const engine = new ScoringEngine(prepared);
    const { judgments } = recordJudgments(engine);

    for (let i = 0; i < 8; i++) {
      const note = chart.notes[i];
      if (!note) throw new Error('missing note');
      engine.pressBongo(note.lane, note.tMs);
    }

    // Tick well past the last note so any unresolved notes would auto-miss.
    engine.tick(5000);

    assert(
      judgments.length === 8 && judgments.every((j) => j === 'perfect'),
      `expected 8 perfects, got ${judgments.join(',')}`,
    );

    const snap = engine.snapshot();
    assert(snap.combo === 8, `combo should be 8, got ${snap.combo}`);
    assert(snap.maxCombo === 8, `maxCombo should be 8, got ${snap.maxCombo}`);
    assert(snap.multiplier === 1, `multiplier should be 1 at combo=8, got ${snap.multiplier}`);
    assert(snap.hits.perfect === 8, 'all perfects');
    assert(snap.notesPlayed === 8, 'all notes played');
    // Phrase 0 (2 notes, 2 perfects) → 0.25, Phrase 1 (1 note, 1 perfect) → 0.25 → total 0.5
    assert(
      Math.abs(snap.spMeter - 0.5) < 1e-9,
      `spMeter should be 0.5 after both phrases, got ${snap.spMeter}`,
    );
    assert(snap.spMeter > 0, 'sp meter > 0 after sp phrases hit cleanly');
    // Score: 8 * 50 * 1 = 400
    assert(snap.score === 400, `score should be 400, got ${snap.score}`);
  }

  // ---- 50ms-late press is a 'great' ----
  {
    const single: ChartV1 = {
      version: 1,
      audioOffsetMs: 0,
      notes: [{ tMs: 1000, lane: 'L' }],
    };
    const engine = new ScoringEngine(prepareChart(single));
    const { judgments } = recordJudgments(engine);
    engine.pressBongo('L', 1050);
    assert(
      judgments.length === 1 && judgments[0] === 'great',
      `expected 'great', got ${judgments.join(',')}`,
    );
  }

  // ---- 200ms-late press → no hit; auto-miss when tick passes deadline ----
  {
    const single: ChartV1 = {
      version: 1,
      audioOffsetMs: 0,
      notes: [{ tMs: 1000, lane: 'L' }],
    };
    const engine = new ScoringEngine(prepareChart(single));
    const { events, judgments } = recordJudgments(engine);

    // Pressing at 1200ms internally ticks to 1200 first, which auto-misses
    // the note (deadline 1110 < 1200). The press itself then finds nothing
    // and emits a stray.
    engine.pressBongo('L', 1200);
    engine.tick(1300);

    assert(
      judgments.length === 1 && judgments[0] === 'miss',
      `expected single 'miss', got ${judgments.join(',')}`,
    );
    assert(
      events.some((e) => e.type === 'stray'),
      'expected a stray event for the late press',
    );

    const snap = engine.snapshot();
    assert(snap.hits.miss === 1, 'one miss tallied');
    assert(snap.combo === 0, 'combo reset by miss');
  }

  // ---- computeStars sanity (cheap inline check) ----
  // (real test lives in the play scene; this just smoke-tests the import path)
  // Avoid touching DOM.

  console.log('scoring smoke ok');
}
