/**
 * Master audio clock for Bongos Hero.
 *
 * Rhythm-game timing must be driven by `AudioContext.currentTime`, not by
 * `performance.now()` or `requestAnimationFrame` deltas. The audio is the
 * ground truth; visuals are slaved to it. This engine exposes a sample-accurate
 * `currentTimeMs()` derived from the AudioContext clock plus bookkeeping
 * around the active `AudioBufferSourceNode`.
 */

export interface AudioEngineOptions {
  /** Constant offset (ms) added to the reported song time. Positive = visuals appear earlier. */
  audioOffsetMs?: number;
}

export type EngineState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended';

type StateChangeCb = (s: EngineState) => void;
type EndedCb = () => void;

interface WebkitWindow {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

function resolveAudioContextCtor(): typeof AudioContext {
  const w = window as unknown as WebkitWindow;
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) {
    throw new Error('Web Audio API is not supported in this environment.');
  }
  return Ctor;
}

export class AudioEngine {
  private _state: EngineState = 'idle';
  private _ctx: AudioContext | null = null;
  private _buffer: AudioBuffer | null = null;
  private _source: AudioBufferSourceNode | null = null;

  /** ctx.currentTime (seconds) at which the current source.start() was called. */
  private _startedAtCtxTime = 0;
  /** The song-time (ms) corresponding to `_startedAtCtxTime`. */
  private _startedAtSongMs = 0;
  /** Saved song position (ms) while paused / ready. */
  private _pausedSongMs = 0;

  private _audioOffsetMs: number;

  private readonly _stateCbs = new Set<StateChangeCb>();
  private readonly _endedCbs = new Set<EndedCb>();

  /**
   * Monotonic token incremented every time we destroy a source. The
   * source's `onended` closure captures its token at creation time and bails
   * out if the live token has moved on — this filters the spurious `onended`
   * fired by manual `stop()` and by source-replacement during seek/resume.
   */
  private _sourceToken = 0;

  constructor(opts: AudioEngineOptions = {}) {
    this._audioOffsetMs = opts.audioOffsetMs ?? 0;
  }

  /** Current state of the engine. */
  get state(): EngineState {
    return this._state;
  }

  /** Total song length in ms once loaded, else 0. */
  get durationMs(): number {
    return this._buffer ? this._buffer.duration * 1000 : 0;
  }

  /**
   * Underlying AudioContext (lazy). The first access constructs it, which is
   * why callers should make sure `load()` or `play()` has run inside a user
   * gesture before reading this from elsewhere.
   */
  get ctx(): AudioContext {
    return this._ensureCtx();
  }

  /** Loads + decodes the audio at `url`. Resolves when ready. */
  async load(url: string): Promise<void> {
    this._setState('loading');
    const ctx = this._ensureCtx();
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`AudioEngine.load: HTTP ${res.status} ${res.statusText} for ${url}`);
      }
      const arrayBuf = await res.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arrayBuf);
      this._buffer = decoded;
      this._pausedSongMs = 0;
      this._startedAtSongMs = 0;
      this._setState('ready');
    } catch (err) {
      this._buffer = null;
      this._setState('idle');
      throw err;
    }
  }

  /** Starts playback from `startMs` (default 0). Requires a prior user gesture. */
  async play(startMs = 0): Promise<void> {
    if (!this._buffer) {
      console.warn('[AudioEngine] play() called before load() completed; ignoring.');
      return;
    }
    const ctx = this._ensureCtx();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* ignore — caller will see no playback */
      }
    }
    // Never overlap audio: tear down any active source first.
    this._stopSourceInternal();
    const clamped = Math.max(0, Math.min(startMs, this._buffer.duration * 1000));
    this._createAndStartSource(clamped);
    this._setState('playing');
  }

  /** Pauses. Cheap to call; no-op outside `playing`. */
  pause(): void {
    if (this._state !== 'playing') return;
    this._pausedSongMs = this._computeSongMsRaw();
    this._stopSourceInternal();
    this._setState('paused');
  }

  /** Resumes from the paused position. No-op outside `paused`. */
  async resume(): Promise<void> {
    if (this._state !== 'paused') return;
    if (!this._buffer) return;
    const ctx = this._ensureCtx();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    this._createAndStartSource(this._pausedSongMs);
    this._setState('playing');
  }

  /** Stops + resets to 0. Releases the source node. */
  stop(): void {
    if (this._state === 'idle' || this._state === 'loading') return;
    this._stopSourceInternal();
    this._pausedSongMs = 0;
    this._startedAtSongMs = 0;
    this._setState(this._buffer ? 'ready' : 'idle');
  }

  /** Seeks to `ms` while preserving play/pause state. */
  seek(ms: number): void {
    if (!this._buffer) return;
    const dur = this._buffer.duration * 1000;
    const target = Math.max(0, Math.min(ms, dur));

    switch (this._state) {
      case 'playing': {
        this._stopSourceInternal();
        this._createAndStartSource(target);
        // State stays 'playing'; no transition broadcast needed.
        return;
      }
      case 'paused': {
        this._pausedSongMs = target;
        return;
      }
      case 'ready':
      case 'ended': {
        // Treat a seek from ready/ended as parking at a position, ready to resume.
        this._pausedSongMs = target;
        this._setState('paused');
        return;
      }
      case 'idle':
      case 'loading':
      default:
        // Nothing meaningful to do.
        return;
    }
  }

  /**
   * Returns the current song time in ms, sample-accurate while playing,
   * frozen while paused, and clamped to [0, durationMs] when ended.
   * Adds the configured audioOffsetMs.
   */
  currentTimeMs(): number {
    const dur = this.durationMs;
    let raw: number;
    switch (this._state) {
      case 'playing':
        raw = this._computeSongMsRaw();
        break;
      case 'paused':
        raw = this._pausedSongMs;
        break;
      case 'ended':
        raw = dur;
        break;
      case 'idle':
      case 'loading':
      case 'ready':
      default:
        raw = 0;
        break;
    }
    if (raw < 0) raw = 0;
    if (dur > 0 && raw > dur) raw = dur;
    return raw + this._audioOffsetMs;
  }

  /** Subscribe to state changes; returns unsubscribe. */
  onStateChange(cb: StateChangeCb): () => void {
    this._stateCbs.add(cb);
    return () => {
      this._stateCbs.delete(cb);
    };
  }

  /** Subscribe to natural end-of-song. */
  onEnded(cb: EndedCb): () => void {
    this._endedCbs.add(cb);
    return () => {
      this._endedCbs.delete(cb);
    };
  }

  /** Update the calibration offset live. */
  setAudioOffsetMs(ms: number): void {
    this._audioOffsetMs = ms;
  }

  // ---- internals ----

  private _ensureCtx(): AudioContext {
    if (!this._ctx) {
      const Ctor = resolveAudioContextCtor();
      this._ctx = new Ctor();
    }
    return this._ctx;
  }

  private _setState(next: EngineState): void {
    if (next === this._state) return;
    this._state = next;
    for (const cb of this._stateCbs) {
      try {
        cb(next);
      } catch (err) {
        console.error('[AudioEngine] state-change subscriber threw:', err);
      }
    }
  }

  private _computeSongMsRaw(): number {
    if (!this._ctx) return this._startedAtSongMs;
    return (this._ctx.currentTime - this._startedAtCtxTime) * 1000 + this._startedAtSongMs;
  }

  private _createAndStartSource(songMs: number): void {
    if (!this._buffer) return;
    const ctx = this._ensureCtx();
    const src = ctx.createBufferSource();
    src.buffer = this._buffer;
    src.connect(ctx.destination);

    const myToken = ++this._sourceToken;
    src.onended = (): void => {
      // Filter stale callbacks from manual stop / seek / re-play.
      if (myToken !== this._sourceToken) return;
      // Natural end-of-song.
      this._source = null;
      this._setState('ended');
      for (const cb of this._endedCbs) {
        try {
          cb();
        } catch (err) {
          console.error('[AudioEngine] ended subscriber threw:', err);
        }
      }
    };

    const offsetSec = Math.max(0, Math.min(songMs / 1000, this._buffer.duration));
    this._startedAtCtxTime = ctx.currentTime;
    this._startedAtSongMs = offsetSec * 1000;
    this._source = src;
    // start(when, offset): when=0 means "as soon as possible".
    src.start(0, offsetSec);
  }

  private _stopSourceInternal(): void {
    if (!this._source) return;
    // Invalidate the source's onended *before* calling stop(): the spec
    // schedules onended asynchronously, but we want any future fire to be
    // recognized as stale.
    this._sourceToken++;
    try {
      this._source.stop();
    } catch {
      /* may not have been started yet */
    }
    try {
      this._source.disconnect();
    } catch {
      /* ignore */
    }
    this._source = null;
  }
}
