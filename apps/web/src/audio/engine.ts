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
 * node, and the engine self-registers per-key appliers against the user
 * settings store at construction so volume + audio-reactive changes
 * propagate live without callers having to wire anything up.
 */

import { register as registerSetting } from '../settings/index.js';

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

  /**
   * Single AnalyserNode tapped off the master bus for the audio-reactive
   * highway-edge glow. Built lazily inside `_ensureCtx` so the engine has
   * no Web-Audio side effects until something else also needs the context.
   * The analyser is a dead-end branch (master.connect(analyser); analyser
   * is not connected to destination) so it does not affect output volume.
   */
  private _analyser: AnalyserNode | null = null;
  /**
   * Reusable byte-frequency buffer sized to `analyser.frequencyBinCount`
   * (= fftSize / 2 = 128 for fftSize=256). Allocated once when the
   * analyser is built; `getLowBandEnergy` writes into it in place every
   * frame so the per-frame call path performs zero allocations.
   */
  private _fftBuf: Uint8Array<ArrayBuffer> | null = null;
  /**
   * Mirror of `Settings.audioReactiveEnabled`. When false, `getLowBandEnergy`
   * skips the analyser sample entirely and returns 0, which lets the
   * renderer also short-circuit the edge-glow draw.
   */
  private _audioReactiveEnabled = true;

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

  /**
   * Active practice-loop range, in song-time ms. `null` on either bound
   * disables looping. Both must be set together; we keep them as separate
   * fields so the loop properties on the live `AudioBufferSourceNode`
   * (set on `setLoopRange` and reapplied on every `_createAndStartSource`)
   * have a single canonical source of truth on the engine.
   */
  private _loopStartMs: number | null = null;
  private _loopEndMs: number | null = null;

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
    // Per-key registrations against the settings store. `register()` invokes
    // each applier synchronously with the current value, so this also seeds
    // `_masterVolume` and `_audioReactiveEnabled` for the next time the
    // AudioContext is built. Volume slider tweaks no longer redundantly
    // re-fire the audio-reactive branch (and vice versa).
    registerSetting('musicVolume', (v) => {
      this.setMasterVolume(v);
    });
    registerSetting('audioReactiveEnabled', (v) => {
      this._audioReactiveEnabled = v;
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
   * Set a song-time loop range. The active `AudioBufferSourceNode` (if any)
   * is configured for native looping via `loop = true` + `loopStart` +
   * `loopEnd`, so the audio wraps without the per-wrap click of tearing the
   * source down. The clock in `currentTimeMs()` reconstructs the wrapped
   * song-time from the wall clock since `AudioContext.currentTime` keeps
   * monotonically increasing across native loops.
   *
   * If no source is currently playing the bounds are stored on the engine
   * and applied to the next `_createAndStartSource()` call.
   *
   * `startMs >= endMs` and non-finite bounds are rejected (no-op + console
   * warning) — a zero or negative range would loop infinitely on the very
   * next frame, and NaN/Infinity would corrupt the clock math.
   */
  setLoopRange(startMs: number, endMs: number): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    if (startMs >= endMs) {
      console.warn(
        `[AudioEngine] setLoopRange: ignoring degenerate range start=${startMs} end=${endMs}`,
      );
      return;
    }
    const start = Math.max(0, startMs);
    this._loopStartMs = start;
    this._loopEndMs = endMs;
    if (this._source) {
      this._source.loop = true;
      this._source.loopStart = start / 1000;
      this._source.loopEnd = endMs / 1000;
    }
  }

  /** Disable the practice-mode loop, if any. The active source plays through naturally. */
  clearLoopRange(): void {
    this._loopStartMs = null;
    this._loopEndMs = null;
    if (this._source) {
      this._source.loop = false;
    }
  }

  /**
   * Current low-frequency energy on the master bus, normalised to `[0, 1]`.
   *
   * Reads the byte-frequency spectrum of the AnalyserNode tap and averages
   * the lowest two bins to estimate the kick/bass band:
   *
   *   bin width Hz = sampleRate / fftSize         (e.g. 48000 / 256 ≈ 187 Hz)
   *   bins 0..1     ≈ 0..375 Hz at 48 kHz         (kick + low-bass range)
   *
   * Returns 0 when no source is currently playing, when the AudioContext
   * (and hence the analyser) hasn't been built yet, or when the player has
   * disabled the audio-reactive accent in Settings — in those cases the
   * renderer skips the edge-glow draw entirely.
   *
   * Hot path: this runs once per frame from the renderer. The byte buffer
   * is reused (`this._fftBuf`) so there is no per-frame allocation.
   */
  getLowBandEnergy(): number {
    if (!this._audioReactiveEnabled) return 0;
    if (this._state !== 'playing') return 0;
    const analyser = this._analyser;
    const buf = this._fftBuf;
    if (!analyser || !buf) return 0;
    analyser.getByteFrequencyData(buf);
    const lowBins = Math.min(2, buf.length);
    if (lowBins === 0) return 0;
    let sum = 0;
    for (let i = 0; i < lowBins; i++) {
      sum += buf[i] ?? 0;
    }
    return sum / (lowBins * 255);
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

      // FFT analyser tap on the master bus, in parallel with the destination
      // so it never alters the audible signal. fftSize=256 gives a 128-bin
      // spectrum — enough resolution to isolate the kick/bass band
      // (~60–250 Hz) at near-zero CPU cost. smoothingTimeConstant = 0.6
      // keeps the per-frame energy from flickering on individual hits.
      const analyser = this._ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      master.connect(analyser);
      this._analyser = analyser;
      // Allocate the byte-frequency buffer once. `getLowBandEnergy` reuses
      // it on every call — no per-frame allocation in the render hot path.
      // Construct from a freshly-typed ArrayBuffer so the TypedArray's
      // backing-store type narrows to `ArrayBuffer` (matches the signature
      // of `AnalyserNode.getByteFrequencyData`).
      this._fftBuf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
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
   * If a practice loop is active and the wall-clock-derived song time has
   * crossed `endMs`, fold it back into `[startMs, endMs)` and re-anchor the
   * clock so subsequent reads stay numerically bounded across many wraps.
   *
   * The native `AudioBufferSourceNode` loop wraps the audio inaudibly, but
   * `AudioContext.currentTime` keeps monotonically increasing, so this
   * modulo step is what keeps the reported song time in sync with what the
   * player hears. Returns the song-time the engine should report.
   *
   * Only called from the 'playing' branch of `currentTimeMs()`.
   */
  private _maybeLoop(rawSongMs: number): number {
    const startMs = this._loopStartMs;
    const endMs = this._loopEndMs;
    if (startMs === null || endMs === null) return rawSongMs;
    if (rawSongMs < endMs) return rawSongMs;

    const loopLengthMs = endMs - startMs;
    const delta = rawSongMs - startMs;
    const wraps = Math.floor(delta / loopLengthMs);
    const reportedSongMs = startMs + (delta - wraps * loopLengthMs);

    // Re-anchor so `_computeSongMsRaw()` keeps producing values close to
    // the loop range on subsequent calls, rather than letting the wall-clock
    // delta grow unbounded across hours of practice.
    if (this._ctx) {
      this._startedAtCtxTime = this._ctx.currentTime;
      this._startedAtSongMs = reportedSongMs;
    }
    return reportedSongMs;
  }

  private _createAndStartSource(songMs: number): void {
    if (!this._buffer) return;
    const ctx = this._ensureCtx();
    const src = ctx.createBufferSource();
    src.buffer = this._buffer;
    // Preserve the active practice / slo-mo rate across source rebuilds
    // (seek, resume). Without this, every restart would silently jump the
    // rate back to 1.0x.
    src.playbackRate.value = this._playbackRate;
    // Route through the master gain so setMasterVolume + the settings
    // subscription actually attenuate the song.
    src.connect(this._master ?? ctx.destination);
    // Apply practice-loop bounds if set before this source existed (e.g.
    // setLoopRange was called from the practice scene before play()).
    if (this._loopStartMs !== null && this._loopEndMs !== null) {
      src.loop = true;
      src.loopStart = this._loopStartMs / 1000;
      src.loopEnd = this._loopEndMs / 1000;
    }

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
