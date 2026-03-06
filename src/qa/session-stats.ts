/**
 * v4: Session-level statistics tracker.
 *
 * Accumulates metrics during a session for post-session QA.
 * Reset on session start, read at session end.
 */

export interface SessionStats {
  /** Total advice envelopes delivered (any channel). */
  adviceDelivered: number;
  /** Advice delivered via Foundry. */
  adviceViaFoundry: number;
  /** Advice delivered via Discord (fallback). */
  adviceViaDiscord: number;
  /** NO_ADVICE / dedup suppressions. */
  adviceSuppressed: number;
  /** Session start time (ISO). */
  sessionStartedAt: string | null;
  /** When ACTIVE was first reached (ISO). */
  activatedAt: string | null;
  /** Activation source (foundry, command, transcript). */
  activationSource: string | null;
  /** Total transcript segments seen (accumulated in real-time, not from ring buffer). */
  totalSegmentCount: number;
  /** Speaker distribution accumulated in real-time (name → segment count). */
  speakerDistribution: Record<string, number>;
}

/** Create a fresh stats object for a new session. */
export function createSessionStats(): SessionStats {
  return {
    adviceDelivered: 0,
    adviceViaFoundry: 0,
    adviceViaDiscord: 0,
    adviceSuppressed: 0,
    sessionStartedAt: null,
    activatedAt: null,
    activationSource: null,
    totalSegmentCount: 0,
    speakerDistribution: {},
  };
}
