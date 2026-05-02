/**
 * Persists the user's audio-vs-video calibration offset across sessions.
 *
 * The offset is intentionally clamped to a sane range (±300 ms): anything
 * beyond that is almost certainly a mistake or hostile input rather than a
 * real human's perception delta.
 */

const KEY = 'bongos.audioOffsetMs';
const MIN_OFFSET_MS = -300;
const MAX_OFFSET_MS = 300;

function clamp(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  if (ms < MIN_OFFSET_MS) return MIN_OFFSET_MS;
  if (ms > MAX_OFFSET_MS) return MAX_OFFSET_MS;
  return ms;
}

/** Reads the persisted offset (ms). Returns 0 if absent or unavailable. */
export function loadAudioOffsetMs(): number {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw == null) return 0;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    return clamp(n);
  } catch {
    return 0;
  }
}

/** Persists the offset (ms), clamped to [-300, 300]. Silently no-ops if storage is unavailable. */
export function saveAudioOffsetMs(ms: number): void {
  try {
    globalThis.localStorage?.setItem(KEY, String(clamp(ms)));
  } catch {
    /* private mode, quota exceeded, no DOM, etc. — nothing useful to do */
  }
}
