import { describe, expect, it, vi } from 'vitest';

import { SfxEngine } from '../sfx.js';

/**
 * Fakes for the slice of the Web Audio API the synthesised stinger /
 * fail-beat methods touch. Each fake is just a vi.fn-backed shape — we
 * don't care about audible output, only about the topology
 * (`createOscillator` count, oscillator types/frequencies, envelope
 * routing) so the synthesis matches the spec.
 */
interface FakeAudioParam {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
}

interface FakeOscillator {
  type: OscillatorType;
  frequency: FakeAudioParam;
  detune: FakeAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

interface FakeGain {
  gain: FakeAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface FakeAudioContext {
  currentTime: number;
  destination: object;
  createGain: ReturnType<typeof vi.fn>;
  createOscillator: ReturnType<typeof vi.fn>;
  oscillators: FakeOscillator[];
  gains: FakeGain[];
}

function makeFakeParam(initial = 0): FakeAudioParam {
  return {
    value: initial,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
}

function makeFakeOscillator(): FakeOscillator {
  return {
    type: 'sine',
    frequency: makeFakeParam(440),
    detune: makeFakeParam(0),
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null,
  };
}

function makeFakeGain(): FakeGain {
  return {
    gain: makeFakeParam(1),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function makeFakeAudioContext(): FakeAudioContext {
  const oscillators: FakeOscillator[] = [];
  const gains: FakeGain[] = [];
  const ctx: FakeAudioContext = {
    currentTime: 0,
    destination: {},
    createGain: vi.fn(() => {
      const g = makeFakeGain();
      gains.push(g);
      return g;
    }),
    createOscillator: vi.fn(() => {
      const o = makeFakeOscillator();
      oscillators.push(o);
      return o;
    }),
    oscillators,
    gains,
  };
  return ctx;
}

function makeEngine(): { eng: SfxEngine; ctx: FakeAudioContext } {
  const ctx = makeFakeAudioContext();
  const eng = new SfxEngine({ ctx: ctx as unknown as AudioContext });
  return { eng, ctx };
}

describe('SfxEngine.playStinger', () => {
  it('builds three oscillators for the C/E/G major chord', () => {
    const { eng, ctx } = makeEngine();
    // The constructor itself builds 1 master gain. Reset call counts so
    // the assertions below describe only what playStinger() does.
    ctx.createGain.mockClear();
    ctx.createOscillator.mockClear();
    const oscBefore = ctx.oscillators.length;
    const gainBefore = ctx.gains.length;

    eng.playStinger();

    // 3 chord voices + 1 envelope gain.
    expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
    expect(ctx.createGain).toHaveBeenCalledTimes(1);

    const newOscs = ctx.oscillators.slice(oscBefore);
    expect(newOscs).toHaveLength(3);

    // All three oscillators are triangles (per the synthesis spec —
    // smoother than a square, brighter than a sine).
    for (const osc of newOscs) {
      expect(osc.type).toBe('triangle');
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
    }

    // Frequencies match a C-major triad in the 5th octave (Hz).
    const freqs = newOscs.map((o) => o.frequency.value).sort((a, b) => a - b);
    expect(freqs[0]).toBeCloseTo(523.25, 2); // C5
    expect(freqs[1]).toBeCloseTo(659.25, 2); // E5
    expect(freqs[2]).toBeCloseTo(783.99, 2); // G5

    // Envelope shape: starts near zero, rises, then exponentially decays.
    const envGain = ctx.gains[gainBefore];
    expect(envGain).toBeDefined();
    expect(envGain?.gain.setValueAtTime).toHaveBeenCalled();
    // Two ramps: attack (rise) + decay (fall).
    expect(envGain?.gain.exponentialRampToValueAtTime).toHaveBeenCalledTimes(2);

    // Envelope routes to the master bus (created in the SfxEngine ctor).
    expect(envGain?.connect).toHaveBeenCalledTimes(1);
  });

  it('routes every oscillator into the envelope gain (not directly to master)', () => {
    const { eng, ctx } = makeEngine();
    const oscBefore = ctx.oscillators.length;
    const gainBefore = ctx.gains.length;

    eng.playStinger();

    const envGain = ctx.gains[gainBefore];
    expect(envGain).toBeDefined();
    const newOscs = ctx.oscillators.slice(oscBefore);
    for (const osc of newOscs) {
      // Each oscillator was connected exactly once, and the target is the
      // envelope (not the master bus). This guarantees the chord respects
      // the envelope shaping rather than playing at full level forever.
      expect(osc.connect).toHaveBeenCalledTimes(1);
      expect(osc.connect).toHaveBeenCalledWith(envGain);
    }
  });
});

describe('SfxEngine.playFailBeat', () => {
  it('builds a single low-frequency sine oscillator with a short envelope', () => {
    const { eng, ctx } = makeEngine();
    ctx.createGain.mockClear();
    ctx.createOscillator.mockClear();
    const oscBefore = ctx.oscillators.length;
    const gainBefore = ctx.gains.length;

    eng.playFailBeat();

    // Exactly one sine oscillator + one envelope gain.
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    expect(ctx.createGain).toHaveBeenCalledTimes(1);

    const osc = ctx.oscillators[oscBefore];
    expect(osc).toBeDefined();
    expect(osc?.type).toBe('sine');
    // 100 Hz is the spec'd "low sympathetic thump" frequency.
    expect(osc?.frequency.value).toBe(100);

    expect(osc?.start).toHaveBeenCalledTimes(1);
    expect(osc?.stop).toHaveBeenCalledTimes(1);

    // Envelope shape: setValueAtTime for the attack floor, then attack +
    // decay ramps. Two ramps total, matching the 200 ms exponential decay.
    const envGain = ctx.gains[gainBefore];
    expect(envGain).toBeDefined();
    expect(envGain?.gain.setValueAtTime).toHaveBeenCalled();
    expect(envGain?.gain.exponentialRampToValueAtTime).toHaveBeenCalledTimes(2);

    // And the envelope still routes through the master bus, so the user's
    // sfxVolume setting still controls the level.
    expect(envGain?.connect).toHaveBeenCalledTimes(1);
  });
});
