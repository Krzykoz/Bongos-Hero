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
  _seekingUntilPerfMs: number;
  _lastReportedSongMs: number;
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
  it('seeks back to startMs when the playing clock crosses endMs', () => {
    const { eng, ctx, source, privates } = setupPlayingEngine({
      durationMs: 60_000,
      // Source was started 30s ago of wall-clock time at song-time 0.
      startedAtCtxTime: 0,
      startedAtSongMs: 0,
      ctxNow: 30, // 30s wall-clock => song-time 30000ms at rate 1
    });
    eng.setLoopRange(10_000, 20_000);
    // First read crosses the boundary and triggers a seek.
    const t = eng.currentTimeMs();
    // Engine reports the wrap-target song time.
    expect(t).toBe(10_000);
    // Bookkeeping: a fresh source was created and started at the wrap point.
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
    expect(privates._source).not.toBe(source); // replaced
    expect(privates._source?.start).toHaveBeenCalledWith(0, 10);
    expect(source.stop).toHaveBeenCalledTimes(1);
    // Anchor reset so subsequent reads return values relative to startMs.
    expect(privates._startedAtSongMs).toBe(10_000);
    expect(privates._startedAtCtxTime).toBe(30);
  });

  it('does not seek when the playing clock has not yet reached endMs', () => {
    const { eng, ctx, source } = setupPlayingEngine({
      durationMs: 60_000,
      startedAtCtxTime: 0,
      startedAtSongMs: 0,
      ctxNow: 15, // song-time 15000, still inside [10000, 20000]
    });
    eng.setLoopRange(10_000, 20_000);
    const t = eng.currentTimeMs();
    expect(t).toBe(15_000);
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
    expect(source.stop).not.toHaveBeenCalled();
  });

  it('clearLoopRange() stops the looping behavior', () => {
    const { eng, ctx, source } = setupPlayingEngine({
      durationMs: 60_000,
      startedAtCtxTime: 0,
      startedAtSongMs: 0,
      ctxNow: 30, // would have wrapped if loop were still active
    });
    eng.setLoopRange(10_000, 20_000);
    eng.clearLoopRange();
    const t = eng.currentTimeMs();
    expect(t).toBe(30_000); // free-running clock, no wrap
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
    expect(source.stop).not.toHaveBeenCalled();
  });

  it('treats startMs >= endMs as a no-op (warns and does not loop)', () => {
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

  it('respects playback rate when checking the loop boundary (rate < 1 delays the wrap)', () => {
    // At rate 0.5, 30s of wall-clock = 15s of song-time. So even though the
    // unscaled clock would have crossed endMs=12s, the rate-scaled clock is
    // still inside the loop.
    const { eng, ctx } = setupPlayingEngine({
      durationMs: 60_000,
      startedAtCtxTime: 0,
      startedAtSongMs: 0,
      ctxNow: 30,
      playbackRate: 0.5,
    });
    eng.setLoopRange(5_000, 18_000);
    const t = eng.currentTimeMs();
    expect(t).toBe(15_000); // 30s * 0.5 = 15s song-time, still < 18s endMs
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it('rejects non-finite loop bounds', () => {
    const { eng, ctx } = setupPlayingEngine({
      durationMs: 60_000,
      startedAtCtxTime: 0,
      startedAtSongMs: 0,
      ctxNow: 30,
    });
    eng.setLoopRange(Number.NaN, 20_000);
    eng.setLoopRange(10_000, Number.POSITIVE_INFINITY);
    // Neither call should have installed a loop range; clock is free-running.
    expect(eng.currentTimeMs()).toBe(30_000);
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });
});
