/**
 * Top-level "play session" types and tiny helpers shared between the play
 * scene, HUD, and results screen.
 *
 * The actual play-scene state machine lives elsewhere; this file just
 * centralises the phase enum and the pure `computeStars` mapping so HUD
 * and results don't drift apart.
 */

export type PlayPhase = 'idle' | 'countin' | 'playing' | 'paused' | 'ended';

export interface PlaySession {
  phase: PlayPhase;
  songId: string;
}

export type StarRating = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Map an accuracy percentage (0–100) to a 0–5 star rating per the spec:
 *   <40 → 0,  40–55 → 1,  55–70 → 2,  70–82 → 3,  82–93 → 4,  ≥93 → 5
 */
export function computeStars(accuracy: number): StarRating {
  if (Number.isNaN(accuracy)) return 0;
  if (accuracy >= 93) return 5;
  if (accuracy >= 82) return 4;
  if (accuracy >= 70) return 3;
  if (accuracy >= 55) return 2;
  if (accuracy >= 40) return 1;
  return 0;
}
