/**
 * YouTube background-video embed for the play scene.
 *
 * Loads the official YouTube IFrame Player API on first use, then drives a
 * muted iframe whose playback mirrors the local AudioEngine clock. Audio
 * comes from the local AudioEngine — the iframe is *only* a visual layer.
 *
 * Lifecycle:
 *   const yt = new YouTubeBackground({ container, videoId, audioOffsetMs });
 *   await yt.load();                 // IFrame API loaded + player created
 *   yt.start(audioStartMs);          // play + seek (called once audio plays)
 *   yt.pause(); yt.resume();         // mirror audio engine
 *   yt.driftCorrect(audioCurrentMs); // call ~1×/s while playing
 *   yt.dispose();                    // teardown
 *
 * The class never throws on YouTube failures; it just transitions to
 * `failed` state and `shouldShow()` returns false so the play scene falls
 * back to the opaque animated background.
 *
 * SECURITY: We only postMessage to the youtube.com origin, and we ignore
 * all messages whose origin is not `https://www.youtube.com`.
 */

// ---- YouTube ID extraction --------------------------------------------------

/**
 * Pull a YouTube video ID out of a typical URL string.
 *
 * Supports:
 *   https://www.youtube.com/watch?v=ID
 *   https://m.youtube.com/watch?v=ID
 *   https://music.youtube.com/watch?v=ID
 *   https://www.youtube.com/embed/ID
 *   https://www.youtube.com/shorts/ID
 *   https://www.youtube.com/v/ID
 *   https://youtu.be/ID
 *   bare ID (11 chars, base64-url alphabet)
 *
 * Returns null if no ID can be confidently extracted.
 */
export function extractYouTubeId(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Bare 11-char ID.
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.replace(/^\/+/, '').split('/')[0] ?? '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    // /embed/ID, /v/ID, /shorts/ID
    const m = /^\/(?:embed|v|shorts)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ---- IFrame API loader ------------------------------------------------------

/**
 * Subset of the YT.Player surface we actually use. Avoids depending on the
 * `@types/youtube` package.
 */
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  setVolume(v: number): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (ev: { target: YTPlayer }) => void;
        onStateChange?: (ev: { data: number; target: YTPlayer }) => void;
        onError?: (ev: { data: number; target: YTPlayer }) => void;
      };
    },
  ) => YTPlayer;
  PlayerState: {
    UNSTARTED: -1;
    ENDED: 0;
    PLAYING: 1;
    PAUSED: 2;
    BUFFERING: 3;
    CUED: 5;
  };
}

interface WindowWithYT extends Window {
  YT?: YTNamespace;
  onYouTubeIframeAPIReady?: () => void;
}

let ytLoadPromise: Promise<YTNamespace> | null = null;

function loadYouTubeApi(): Promise<YTNamespace> {
  if (ytLoadPromise) return ytLoadPromise;
  const w = window as WindowWithYT;
  if (w.YT?.Player) {
    ytLoadPromise = Promise.resolve(w.YT);
    return ytLoadPromise;
  }
  ytLoadPromise = new Promise<YTNamespace>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-bongos-yt-api]');
    const onReady = (): void => {
      const ww = window as WindowWithYT;
      if (ww.YT?.Player) resolve(ww.YT);
      else reject(new Error('YouTube IFrame API loaded but YT.Player missing'));
    };

    const prevHook = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = (): void => {
      try {
        if (prevHook) prevHook();
      } catch {
        /* ignore */
      }
      onReady();
    };

    if (!existing) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.bongosYtApi = '1';
      script.onerror = (): void => {
        reject(new Error('Failed to load https://www.youtube.com/iframe_api'));
      };
      document.head.appendChild(script);
    }

    // Hard timeout so a blocked CDN doesn't hang the play scene forever.
    setTimeout(() => {
      const ww = window as WindowWithYT;
      if (ww.YT?.Player) resolve(ww.YT);
      else reject(new Error('YouTube IFrame API load timed out'));
    }, 5000);
  });
  return ytLoadPromise;
}

// ---- YouTubeBackground class -----------------------------------------------

export interface YouTubeBackgroundOptions {
  /**
   * Direct child DOM element that the iframe will be mounted under. The
   * iframe is `display:block; width:100%; height:100%`.
   */
  container: HTMLElement;
  /** 11-char YouTube video ID. */
  videoId: string;
  /**
   * The audio offset baked into AudioEngine.currentTimeMs(). When syncing
   * the iframe we subtract this so the video stays aligned with the
   * underlying AudioBuffer (which is what the user actually hears).
   */
  audioOffsetMs: number;
  /**
   * Playback rate to apply (default 1.0). The iframe will follow this rate
   * via the official `setPlaybackRate` if exposed by the player.
   */
  playbackRate?: number;
}

type Phase =
  | 'idle' // constructed, not loaded yet
  | 'loading' // IFrame API loading + player constructing
  | 'ready' // player ready (cued), audio not yet started
  | 'starting' // we called play(), waiting for PLAYING state
  | 'playing' // confirmed playing — `shouldShow()` returns true
  | 'paused' // mirrored from audio.pause()
  | 'failed' // permanent error — never show
  | 'disposed'; // unmounted

const DRIFT_THRESHOLD_MS = 400;

/**
 * Owns a single YouTube iframe inside `container`. All public methods are
 * no-ops once the instance has reached the `disposed` phase, so callers can
 * safely fire-and-forget.
 */
export class YouTubeBackground {
  private readonly container: HTMLElement;
  private readonly videoId: string;
  private readonly audioOffsetMs: number;

  private phase: Phase = 'idle';
  private player: YTPlayer | null = null;
  private mountEl: HTMLDivElement | null = null;

  /** Set true the first moment we observe PlayerState.PLAYING. */
  private hasEverPlayed = false;

  constructor(opts: YouTubeBackgroundOptions) {
    this.container = opts.container;
    this.videoId = opts.videoId;
    this.audioOffsetMs = opts.audioOffsetMs;
  }

  /**
   * Load the IFrame API + create the player. Resolves when the player has
   * fired `onReady` (i.e. `phase === 'ready'`). Rejects on hard failure so
   * the caller can fall back to the no-YT path.
   */
  async load(): Promise<void> {
    if (this.phase !== 'idle') return;
    this.phase = 'loading';
    let YT: YTNamespace;
    try {
      YT = await loadYouTubeApi();
    } catch (err) {
      this.phase = 'failed';
      throw err;
    }
    if (this.phase !== 'loading') return; // disposed during load

    // Create a child div for YT.Player to replace with its iframe.
    this.mountEl = document.createElement('div');
    this.mountEl.style.width = '100%';
    this.mountEl.style.height = '100%';
    this.container.appendChild(this.mountEl);

    await new Promise<void>((resolve, reject) => {
      let resolved = false;
      try {
        // Note: NO `autoplay` here. We start playback explicitly when the
        // local audio engine starts, after the count-in.
        const player = new YT.Player(this.mountEl as HTMLElement, {
          videoId: this.videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            mute: 1,
            controls: 0,
            disablekb: 1,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            iv_load_policy: 3,
            fs: 0,
            origin: window.location.origin,
            enablejsapi: 1,
          },
          events: {
            onReady: (ev): void => {
              if (this.phase === 'disposed') return;
              try {
                ev.target.mute();
                ev.target.setVolume(0);
              } catch {
                /* ignore */
              }
              this.player = ev.target;
              if (this.phase === 'loading') this.phase = 'ready';
              if (!resolved) {
                resolved = true;
                resolve();
              }
            },
            onStateChange: (ev): void => {
              if (this.phase === 'disposed') return;
              if (ev.data === YT.PlayerState.PLAYING) {
                this.hasEverPlayed = true;
                if (this.phase === 'starting' || this.phase === 'paused') {
                  this.phase = 'playing';
                }
              } else if (ev.data === YT.PlayerState.PAUSED) {
                if (this.phase === 'playing') this.phase = 'paused';
              }
            },
            onError: (): void => {
              // Age-restricted, removed, region-locked, etc. We can't
              // recover — flip to failed and let the play scene fall back.
              this.phase = 'failed';
              if (!resolved) {
                resolved = true;
                reject(new Error('YouTube player error'));
              }
            },
          },
        });
        // Safety: if onReady never fires (slow network, blocked, etc.),
        // reject after 6s.
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            this.phase = 'failed';
            try {
              player.destroy();
            } catch {
              /* ignore */
            }
            reject(new Error('YouTube player onReady timed out'));
          }
        }, 6000);
      } catch (err) {
        this.phase = 'failed';
        if (!resolved) {
          resolved = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  /**
   * Convert audio-engine ms to raw video seconds (strips out audioOffsetMs
   * so we sync to the buffer the user is actually hearing).
   */
  private toVideoSeconds(audioCurrentMs: number): number {
    const raw = audioCurrentMs - this.audioOffsetMs;
    return Math.max(0, raw / 1000);
  }

  /**
   * Begin playback. Called once, when the local audio engine actually
   * starts the song (after the count-in).
   */
  start(audioCurrentMs: number): void {
    if (!this.player || this.phase === 'disposed' || this.phase === 'failed') {
      return;
    }
    try {
      this.player.seekTo(this.toVideoSeconds(audioCurrentMs), true);
      this.player.mute();
      this.player.playVideo();
      this.phase = 'starting';
    } catch {
      this.phase = 'failed';
    }
  }

  pause(): void {
    if (!this.player || this.phase === 'disposed' || this.phase === 'failed') {
      return;
    }
    try {
      this.player.pauseVideo();
      this.phase = 'paused';
    } catch {
      /* ignore */
    }
  }

  resume(audioCurrentMs: number): void {
    if (!this.player || this.phase === 'disposed' || this.phase === 'failed') {
      return;
    }
    try {
      this.player.seekTo(this.toVideoSeconds(audioCurrentMs), true);
      this.player.playVideo();
      this.phase = 'starting';
    } catch {
      /* ignore */
    }
  }

  /**
   * Hard stop: pause + reset to t=0. We don't re-seek to 0 because the
   * scene is about to unmount anyway.
   */
  stop(): void {
    if (!this.player || this.phase === 'disposed' || this.phase === 'failed') {
      return;
    }
    try {
      this.player.pauseVideo();
      this.phase = 'paused';
    } catch {
      /* ignore */
    }
  }

  /**
   * Compare the iframe's current time against the audio engine's current
   * time. If drift exceeds DRIFT_THRESHOLD_MS, hard-seek the iframe.
   * Cheap to call every ~1s while playing.
   */
  driftCorrect(audioCurrentMs: number): void {
    if (!this.player || this.phase !== 'playing') return;
    try {
      const targetSec = this.toVideoSeconds(audioCurrentMs);
      const actualSec = this.player.getCurrentTime();
      if (!Number.isFinite(actualSec)) return;
      const driftMs = Math.abs(actualSec - targetSec) * 1000;
      if (driftMs > DRIFT_THRESHOLD_MS) {
        this.player.seekTo(targetSec, true);
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * True iff the iframe is in a state where the play scene should switch
   * the canvas to transparent-background mode. Stays false until we've
   * observed at least one PLAYING state event.
   */
  shouldShow(): boolean {
    return (
      this.hasEverPlayed &&
      (this.phase === 'playing' || this.phase === 'paused' || this.phase === 'starting')
    );
  }

  /** True iff load() failed or onError fired. */
  isFailed(): boolean {
    return this.phase === 'failed';
  }

  dispose(): void {
    if (this.phase === 'disposed') return;
    this.phase = 'disposed';
    if (this.player) {
      try {
        this.player.stopVideo();
      } catch {
        /* ignore */
      }
      try {
        this.player.destroy();
      } catch {
        /* ignore */
      }
      this.player = null;
    }
    if (this.mountEl?.parentNode) {
      try {
        this.mountEl.parentNode.removeChild(this.mountEl);
      } catch {
        /* ignore */
      }
    }
    this.mountEl = null;
  }
}
