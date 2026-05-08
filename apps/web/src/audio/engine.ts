/**
 * Master audio clock for Bongos Hero.
 *
 * Rhythm-game timing must be driven by `AudioContext.currentTime`, not by
 * `performance.now()` or `requestAnimationFrame` deltas. The audio is the
 * ground truth; visuals are slaved to it. This engine exposes a sample-accurate
 * `currentTimeMs()` derived from the AudioContext clock plus bookkeeping
 * around the active `AudioBufferSourceNode`.
 *
 * Routing: the active `AudioBufferSourceNode` connects to a single internal
 * `_master` GainNode (lazy-built with the AudioContext) which connects to
 * `ctx.destination`. `setMasterVolume(v)` writes a clamped value to that
 * node, and the engine self-subscribes to the user settings store at
 * construction so volume changes propagate live.
 */

import { subscribe as subscribeSettings } from '../settings/index.js';

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
  private _master: GainNode | null = null;
  private _masterVolume = 1;
  private _buffer: AudioBuffer | null = null;
  private _source: AudioBufferSourceNode | null = null;

  /** ctx.currentTime (seconds) at which the current source.start() was called. */
  private _startedAtCtxTime = 0;
  /** The song-time (ms) corresponding to `_startedAtCtxTime`. */
  private _startedAtSongMs = 0;
  /** Saved song position (ms) while paused / ready. */
  private _pausedSongMs = 0;

  /**
   * Last set playback rate. Tracked here (in addition to being written to the
   * AudioParam on `_source.playbackRate`) so it survives source replacement
   * (seek / loop-restart) and so `_computeSongMsRaw()` can scale the
   * wall-clock-derived elapsed time into actual song time. Defaults to 1.
   */
  private _playbackRate = 1;

  /** Active practice-loop range; `null` disables looping. */
  private _loopRange: { startMs: number; endMs: number } | null = null;
  /**
   * Wall-clock ms until which `currentTimeMs()` should return the
   * pre-seek song time instead of recomputing. Set briefly after a
   * loop-triggered seek so external callers don't see a one-frame backwards
   * jump while the new BufferSource is still ramping up to producing
   * samples. The seek itself is synchronous in terms of bookkeeping so the
   * window is small (~10ms wall-clock); we err on the safe side here.
   */
  private _seekingUntilPerfMs = 0;
  /** Last raw song-time reported by `currentTimeMs()`, used during the seek window. */
  private _lastReportedSongMs = 0;

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
    // Self-subscribe to settings so music volume changes propagate live
    // without callers having to wire anything up. `subscribe` invokes
    // synchronously with the current settings, so this also seeds
    // `_masterVolume` for the next time the AudioContext is built.
    subscribeSettings((s) => {
      this.setMasterVolume(s.musicVolume);
    });
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
        raw = this._maybeLoop(this._computeSongMsRaw());
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
    this._lastReportedSongMs = raw;
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

  /**
   * Set the master gain (clamped to [0, 1]). Safe to call before the
   * AudioContext exists — the value is stashed and applied when the master
   * node is built lazily.
   */
  setMasterVolume(v: number): void {
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(0, Math.min(1, v));
    this._masterVolume = clamped;
    if (this._master) this._master.gain.value = clamped;
  }

  /**
   * Set the playback rate of the active AudioBufferSource (clamped to
   * [0.25, 2.0]). With `rampMs <= 0` the value is written immediately;
   * otherwise the engine cancels any in-flight schedule, anchors the
   * current value at `now`, and linearly ramps to `rate` over `rampMs`
   * milliseconds.
   *
   * No-op when no source is playing (no song loaded / engine idle), so it
   * is safe to call defensively from gameplay code.
   *
   * NOTE on the master clock: changing `playbackRate` desyncs
   * `currentTimeMs()` because that method is derived from
   * `AudioContext.currentTime`, which advances at wall-clock speed
   * regardless of the source's playback rate. We accept the desync (option
   * (b) in the spec) — for the brief slo-mo window (~80ms) at combo ≥ 20
   * the player is unlikely to be hitting another note exactly inside it,
   * and any misjudgment is bounded to a single-frame drift. Pausing the
   * scoring clock for 80ms would add a lot more code surface for almost
   * no perceived gameplay benefit.
   */
  setPlaybackRate(rate: number, rampMs = 0): void {
    if (!Number.isFinite(rate)) return;
    const clamped = Math.max(0.25, Math.min(2.0, rate));
    // Re-anchor the song-time clock at the current position before
    // switching rates, so `_computeSongMsRaw()` keeps reporting a
    // continuous timeline across the rate change. Without this, callers
    // would see an instant jump in the song clock the moment rate flips,
    // since `_computeSongMsRaw()` multiplies the wall-clock elapsed since
    // `_startedAtCtxTime` by `_playbackRate`.
    if (this._ctx && this._state === 'playing') {
      const cur = this._computeSongMsRaw();
      this._startedAtCtxTime = this._ctx.currentTime;
      this._startedAtSongMs = cur;
    }
    this._playbackRate = clamped;
    if (!this._source) return;
    const param = this._source.playbackRate;
    if (rampMs <= 0) {
      param.value = clamped;
      return;
    }
    const ctx = this._ensureCtx();
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(clamped, now + rampMs / 1000);
  }

  /**
   * Set a song-time loop range. While playing, once `currentTimeMs()`
   * reaches `endMs` the engine seeks back to `startMs` automatically.
   * Both values are in song time (ms) and are independent of the current
   * playback rate (the boundary is in song time, not wall-clock time).
   *
   * `startMs >= endMs` is rejected (no-op + console warning) — a zero or
   * negative range would loop infinitely on the very next frame.
   */
  setLoopRange(startMs: number, endMs: number): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    if (startMs >= endMs) {
      console.warn(
        `[AudioEngine] setLoopRange: ignoring degenerate range start=${startMs} end=${endMs}`,
      );
      return;
    }
    this._loopRange = { startMs: Math.max(0, startMs), endMs };
  }

  /** Disable the practice-mode loop, if any. */
  clearLoopRange(): void {
    this._loopRange = null;
  }

  // ---- internals ----

  private _ensureCtx(): AudioContext {
    if (!this._ctx) {
      const Ctor = resolveAudioContextCtor();
      this._ctx = new Ctor();
      const master = this._ctx.createGain();
      master.gain.value = this._masterVolume;
      master.connect(this._ctx.destination);
      this._master = master;
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
    return (
      (this._ctx.currentTime - this._startedAtCtxTime) * 1000 * this._playbackRate +
      this._startedAtSongMs
    );
  }

  /**
   * If a practice loop is active and we've crossed `endMs`, restart the
   * source at `startMs`. Returns the song-time the engine should report
   * for this `currentTimeMs()` call (which is `startMs` after a wrap, the
   * frozen pre-seek value during the very brief seek window, or the raw
   * computed time otherwise).
   *
   * Only called from the 'playing' branch of `currentTimeMs()`.
   */
  private _maybeLoop(rawSongMs: number): number {
    const loop = this._loopRange;
    if (!loop) return rawSongMs;
    const nowPerf =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : 0;
    if (nowPerf < this._seekingUntilPerfMs) {
      // Still inside the recently-seeked stability window — return the
      // pre-seek value so callers don't see a one-frame backwards blip.
      return this._lastReportedSongMs;
    }
    if (rawSongMs < loop.endMs) return rawSongMs;
    // Wrap. Tear down + rebuild the source at startMs.
    this._stopSourceInternal();
    this._createAndStartSource(loop.startMs);
    // Establish a small wall-clock window during which `currentTimeMs()`
    // returns the freshly-anchored startMs without re-deriving from
    // `ctx.currentTime`. The bookkeeping is correct, but a paranoid
    // belt-and-braces guard against a one-frame regression where ctx
    // hasn't yet ticked but performance.now() races ahead is cheap.
    this._seekingUntilPerfMs = nowPerf + 10;
    return loop.startMs;
  }

  private _createAndStartSource(songMs: number): void {
    if (!this._buffer) return;
    const ctx = this._ensureCtx();
    const src = ctx.createBufferSource();
    src.buffer = this._buffer;
    // Preserve the active practice / slo-mo rate across source rebuilds
    // (seek, resume, loop wrap). Without this, every restart would silently
    // jump the rate back to 1.0x.
    src.playbackRate.value = this._playbackRate;
    // Route through the master gain so setMasterVolume + the settings
    // subscription actually attenuate the song.
    src.connect(this._master ?? ctx.destination);

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
