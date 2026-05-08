import { describe, expect, it, vi } from 'vitest';

import { AudioEngine } from '../engine.js';

interface FakeAudioParam {
  value: number;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
}

interface FakeSource {
  playbackRate: FakeAudioParam;
}

interface EnginePrivates {
  _source: FakeSource | null;
  _ctx: { currentTime: number } | null;
}

function makeFakeSource(initial = 1): FakeSource {
  return {
    playbackRate: {
      value: initial,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
  };
}

function attachFakeSource(eng: AudioEngine, source: FakeSource, currentTime = 0): void {
  const privates = eng as unknown as EnginePrivates;
  privates._source = source;
  privates._ctx = { currentTime };
}

// ---- Richer fakes for loop-range integration tests ---------------------------

interface RichFakeSource extends FakeSource {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
}

interface RichFakeCtx {
  currentTime: number;
  state: 'running' | 'suspended' | 'closed';
  destination: object;
  createGain: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
}

interface RichEnginePrivates {
  _source: RichFakeSource | null;
  _ctx: RichFakeCtx | null;
  _master: object | null;
  _buffer: AudioBuffer | null;
  _state: 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended';
  _startedAtCtxTime: number;
  _startedAtSongMs: number;
  _playbackRate: number;
  _loopStartMs: number | null;
  _loopEndMs: number | null;
}

function makeRichFakeSource(initial = 1): RichFakeSource {
  return {
    buffer: null,
    playbackRate: {
      value: initial,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null,
    loop: false,
    loopStart: 0,
    loopEnd: 0,
  };
}

function makeRichFakeCtx(currentTime = 0): RichFakeCtx {
  return {
    currentTime,
    state: 'running',
    destination: {},
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() })),
    createBufferSource: vi.fn(() => makeRichFakeSource()),
  };
}

function setupPlayingEngine(opts: {
  durationMs: number;
  startedAtCtxTime: number;
  startedAtSongMs: number;
  ctxNow: number;
  playbackRate?: number;
}): { eng: AudioEngine; ctx: RichFakeCtx; source: RichFakeSource; privates: RichEnginePrivates } {
  const eng = new AudioEngine();
  const buffer = { duration: opts.durationMs / 1000 } as unknown as AudioBuffer;
  const ctx = makeRichFakeCtx(opts.ctxNow);
  const source = makeRichFakeSource(opts.playbackRate ?? 1);
  const privates = eng as unknown as RichEnginePrivates;
  privates._ctx = ctx;
  privates._buffer = buffer;
  privates._source = source;
  privates._master = null;
  privates._state = 'playing';
  privates._startedAtCtxTime = opts.startedAtCtxTime;
  privates._startedAtSongMs = opts.startedAtSongMs;
  privates._playbackRate = opts.playbackRate ?? 1;
  return { eng, ctx, source, privates };
}

describe('AudioEngine.setPlaybackRate', () => {
  describe('slo-mo on miss', () => {
    it('is a safe no-op when no song is loaded (no source)', () => {
      const eng = new AudioEngine();
      expect(() => {
        eng.setPlaybackRate(0.85);
      }).not.toThrow();
      expect(() => {
        eng.setPlaybackRate(0.85, 30);
      }).not.toThrow();
    });

    it('clamps rates below 0.25 up to 0.25', () => {
      const eng = new AudioEngine();
      const src = makeFakeSource();
      attachFakeSource(eng, src);
      eng.setPlaybackRate(0.1);
      expect(src.playbackRate.value).toBe(0.25);
      eng.setPlaybackRate(-5);
      expect(src.playbackRate.value).toBe(0.25);
    });

    it('clamps rates above 2.0 down to 2.0', () => {
      const eng = new AudioEngine();
      const src = makeFakeSource();
      attachFakeSource(eng, src);
      eng.setPlaybackRate(3.5);
      expect(src.playbackRate.value).toBe(2.0);
      eng.setPlaybackRate(99);
      expect(src.playbackRate.value).toBe(2.0);
    });

    it('writes the value immediately when rampMs <= 0', () => {
      const eng = new AudioEngine();
      const src = makeFakeSource();
      attachFakeSource(eng, src);
      eng.setPlaybackRate(0.85);
      expect(src.playbackRate.value).toBe(0.85);
      expect(src.playbackRate.linearRampToValueAtTime).not.toHaveBeenCalled();
    });

    it('schedules a linear ramp when rampMs > 0', () => {
      const eng = new AudioEngine();
      const src = makeFakeSource(1);
      attachFakeSource(eng, src, 10);
      eng.setPlaybackRate(0.85, 30);
      expect(src.playbackRate.cancelScheduledValues).toHaveBeenCalledWith(10);
      expect(src.playbackRate.setValueAtTime).toHaveBeenCalledWith(1, 10);
      expect(src.playbackRate.linearRampToValueAtTime).toHaveBeenCalledWith(0.85, 10 + 30 / 1000);
    });

    it('ignores non-finite inputs', () => {
      const eng = new AudioEngine();
      const src = makeFakeSource(1);
      attachFakeSource(eng, src);
      eng.setPlaybackRate(Number.NaN);
      eng.setPlaybackRate(Number.POSITIVE_INFINITY);
      expect(src.playbackRate.value).toBe(1);
    });
  });
});

describe('AudioEngine practice loop range', () => {
  it('sets native loop properties on the live source and reports wrapped song-time', () => {
    const { eng, ctx, source, privates } = setupPlayingEngine({
      durationMs: 60_000,
      // Source was started 30s ago of wall-clock time at song-time 0.
      startedAtCtxTime: 0,
      startedAtSongMs: 0,
      ctxNow: 30, // 30s wall-clock => song-time 30000ms at rate 1
    });
    eng.setLoopRange(10_000, 20_000);
    // Native loop properties applied to the live source — no tear-down,
    // no fresh BufferSource. The Web Audio engine wraps the audio itself.
    expect(source.loop).toBe(true);
    expect(source.loopStart).toBe(10);
    expect(source.loopEnd).toBe(20);
    // currentTimeMs reconstructs the wrapped song-time from the wall clock.
    // raw=30000, delta=20000, wraps=2, reported = 10000 + 0 = 10000.
    const t = eng.currentTimeMs();
    expect(t).toBe(10_000);
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
    expect(source.stop).not.toHaveBeenCalled();
    // Anchor reset so subsequent reads stay bounded against the wall clock.
    expect(privates._startedAtSongMs).toBe(10_000);
    expect(privates._startedAtCtxTime).toBe(30);
  });

  it('does not wrap when the playing clock has not yet reached endMs', () => {
    const { eng, ctx, source } = setupPlayingEngine({
      durationMs: 60_000,
      startedAtCtxTime: 0,
      startedAtSongMs: 0,
      ctxNow: 15, // song-time 15000, still inside [10000, 20000]
    });
    eng.setLoopRange(10_000, 20_000);
    // Properties still get pushed to the source so the audio loops natively
    // when it eventually reaches the boundary.
    expect(source.loop).toBe(true);
    expect(source.loopStart).toBe(10);
    expect(source.loopEnd).toBe(20);
    const t = eng.currentTimeMs();
    expect(t).toBe(15_000);
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
    expect(source.stop).not.toHaveBeenCalled();
  });

  it('clearLoopRange() disables the native loop and stops wrap math', () => {
    const { eng, ctx, source } = setupPlayingEngine({
      durationMs: 60_000,
      startedAtCtxTime: 0,
      startedAtSongMs: 0,
      ctxNow: 30, // would have wrapped if loop were still active
    });
    eng.setLoopRange(10_000, 20_000);
    expect(source.loop).toBe(true);
    eng.clearLoopRange();
    // The source plays through to end naturally — loop flag flipped off.
    expect(source.loop).toBe(false);
    const t = eng.currentTimeMs();
    expect(t).toBe(30_000); // free-running clock, no wrap
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
    expect(source.stop).not.toHaveBeenCalled();
  });

  it('treats startMs >= endMs as a no-op (warns and does not arm the loop)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { eng, ctx, source } = setupPlayingEngine({
        durationMs: 60_000,
        startedAtCtxTime: 0,
        startedAtSongMs: 0,
        ctxNow: 30,
      });
      // Equal bounds: degenerate.
      eng.setLoopRange(15_000, 15_000);
      // Inverted bounds: also degenerate.
      eng.setLoopRange(20_000, 10_000);
      // Neither call should have flipped the loop flag on the live source.
      expect(source.loop).toBe(false);
      const t = eng.currentTimeMs();
      // Free-running, no wrap occurred.
      expect(t).toBe(30_000);
      expect(ctx.createBufferSource).not.toHaveBeenCalled();
      expect(source.stop).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('respects playback rate when computing the wrap (rate < 1 delays it)', () => {
    // At rate 0.5, 30s of wall-clock = 15s of song-time. Even though the
    // unscaled clock would have crossed endMs=18s, the rate-scaled clock is
    // still inside the loop and no wrap math runs.
    const { eng, ctx, source } = setupPlayingEngine({
      durationMs: 60_000,
      startedAtCtxTime: 0,
      startedAtSongMs: 0,
      ctxNow: 30,
      playbackRate: 0.5,
    });
    eng.setLoopRange(5_000, 18_000);
    expect(source.loop).toBe(true);
    const t = eng.currentTimeMs();
    expect(t).toBe(15_000); // 30s * 0.5 = 15s song-time, still < 18s endMs
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it('rejects non-finite loop bounds', () => {
    const { eng, ctx, source } = setupPlayingEngine({
      durationMs: 60_000,
      startedAtCtxTime: 0,
      startedAtSongMs: 0,
      ctxNow: 30,
    });
    eng.setLoopRange(Number.NaN, 20_000);
    eng.setLoopRange(10_000, Number.POSITIVE_INFINITY);
    // Neither call should have armed the loop.
    expect(source.loop).toBe(false);
    expect(eng.currentTimeMs()).toBe(30_000);
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it('reports a song-time inside [startMs, endMs) after a native wrap', () => {
    // raw=35000, delta=25000, loopLength=10000, wraps=2, reported=15000.
    const { eng } = setupPlayingEngine({
      durationMs: 60_000,
      startedAtCtxTime: 0,
      startedAtSongMs: 0,
      ctxNow: 35,
    });
    eng.setLoopRange(10_000, 20_000);
    const t = eng.currentTimeMs();
    expect(t).toBeGreaterThanOrEqual(10_000);
    expect(t).toBeLessThan(20_000);
    expect(t).toBe(15_000);
  });

  it('applies a stored loop range to the next source when set before playback starts', async () => {
    // Engine is not yet playing; setLoopRange should stash the bounds so
    // they're applied when _createAndStartSource fires from play().
    const eng = new AudioEngine();
    const buffer = { duration: 60 } as unknown as AudioBuffer;
    const ctx = makeRichFakeCtx(0);
    const privates = eng as unknown as RichEnginePrivates;
    privates._ctx = ctx;
    privates._buffer = buffer;
    privates._master = null;
    privates._state = 'ready';

    eng.setLoopRange(10_000, 20_000);
    expect(privates._source).toBeNull();

    await eng.play(0);

    const newSource = privates._source;
    expect(newSource).not.toBeNull();
    expect(newSource?.loop).toBe(true);
    expect(newSource?.loopStart).toBe(10);
    expect(newSource?.loopEnd).toBe(20);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
  });
});

// ---- Analyser / FFT low-band energy -----------------------------------------

interface FakeAnalyser {
  fftSize: number;
  smoothingTimeConstant: number;
  frequencyBinCount: number;
  getByteFrequencyData: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface AnalyserEnginePrivates {
  _state: 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended';
  _analyser: FakeAnalyser | null;
  _fftBuf: Uint8Array | null;
  _audioReactiveEnabled: boolean;
}

function makeFakeAnalyser(fillBytes: readonly number[] = []): FakeAnalyser {
  const fftSize = 256;
  const frequencyBinCount = fftSize / 2;
  return {
    fftSize,
    smoothingTimeConstant: 0.6,
    frequencyBinCount,
    // Mirror the real `AnalyserNode.getByteFrequencyData` contract: write
    // the current spectrum into the caller-provided Uint8Array in place.
    getByteFrequencyData: vi.fn((out: Uint8Array): void => {
      const n = Math.min(out.length, fillBytes.length);
      for (let i = 0; i < n; i++) {
        out[i] = fillBytes[i] ?? 0;
      }
      for (let i = n; i < out.length; i++) {
        out[i] = 0;
      }
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function attachAnalyser(
  eng: AudioEngine,
  analyser: FakeAnalyser,
  state: AnalyserEnginePrivates['_state'] = 'playing',
): { privates: AnalyserEnginePrivates; buf: Uint8Array } {
  const privates = eng as unknown as AnalyserEnginePrivates;
  const buf = new Uint8Array(analyser.frequencyBinCount);
  privates._analyser = analyser;
  privates._fftBuf = buf;
  privates._state = state;
  return { privates, buf };
}

describe('AudioEngine analyser', () => {
  it('getLowBandEnergy() returns 0 when no source is playing', () => {
    const eng = new AudioEngine();
    // Fresh engine: state is 'idle', no analyser built — no FFT sample
    // should run, no allocation, and the renderer-facing value is 0.
    expect(eng.getLowBandEnergy()).toBe(0);

    // Even with an analyser attached, a non-'playing' state must short
    // out before sampling — the highway pulse should freeze when the
    // player pauses or seeks.
    const analyser = makeFakeAnalyser([255, 255, 0, 0]);
    attachAnalyser(eng, analyser, 'paused');
    expect(eng.getLowBandEnergy()).toBe(0);
    expect(analyser.getByteFrequencyData).not.toHaveBeenCalled();
  });

  it('getLowBandEnergy() returns ~1.0 for a full low-band spectrum', () => {
    // Bins 0..1 saturated, all higher bins silent. The function averages
    // (255 + 255) / (2 * 255) = 1.0 — peak kick/bass energy.
    const eng = new AudioEngine();
    const analyser = makeFakeAnalyser([255, 255, 0, 0]);
    attachAnalyser(eng, analyser, 'playing');
    const energy = eng.getLowBandEnergy();
    expect(energy).toBeCloseTo(1.0, 5);
    expect(analyser.getByteFrequencyData).toHaveBeenCalledTimes(1);
  });

  it('getLowBandEnergy() returns ~0 for a silent spectrum', () => {
    const eng = new AudioEngine();
    const analyser = makeFakeAnalyser([0, 0, 0, 0]);
    attachAnalyser(eng, analyser, 'playing');
    expect(eng.getLowBandEnergy()).toBe(0);
  });

  it('reuses the same Uint8Array buffer on every call (no per-frame allocation)', () => {
    // The renderer hits this once per frame, so the engine must hand the
    // analyser the SAME buffer reference every time. We capture the arg on
    // each call and compare references — anything else would imply a
    // hidden allocation in the hot path.
    const eng = new AudioEngine();
    const analyser = makeFakeAnalyser([128, 64, 0, 0]);
    const { buf } = attachAnalyser(eng, analyser, 'playing');

    eng.getLowBandEnergy();
    eng.getLowBandEnergy();
    eng.getLowBandEnergy();

    expect(analyser.getByteFrequencyData).toHaveBeenCalledTimes(3);
    const calls = analyser.getByteFrequencyData.mock.calls;
    expect(calls[0]?.[0]).toBe(buf);
    expect(calls[1]?.[0]).toBe(buf);
    expect(calls[2]?.[0]).toBe(buf);
  });

  it('returns 0 when audioReactiveEnabled is false (skips the analyser sample)', () => {
    // Settings off -> renderer should also skip its draw, but the engine
    // must short-circuit *before* touching the analyser to keep CPU at
    // exactly zero on mobile / low-end devices.
    const eng = new AudioEngine();
    const analyser = makeFakeAnalyser([255, 255, 0, 0]);
    const { privates } = attachAnalyser(eng, analyser, 'playing');
    privates._audioReactiveEnabled = false;
    expect(eng.getLowBandEnergy()).toBe(0);
    expect(analyser.getByteFrequencyData).not.toHaveBeenCalled();
  });
});
