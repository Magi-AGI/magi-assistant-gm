/**
 * v4: Session-level statistics tracker.
 *
 * Accumulates metrics during a session for post-session QA.
 * Reset on session start, read at session end.
 */

import type { SuppressionReason } from '../types/index.js';
export type { SuppressionReason };

export interface SuppressedSample {
  reason: SuppressionReason;
  /** ISO timestamp of the suppression decision. */
  timestamp: string;
  /** TriggerEvent.type values for the events that motivated this candidate. */
  eventTypes: string[];
  /** Highest priority across the events (1 = highest). */
  priority: number;
  /** Suggested advice body, when an envelope was produced before the gate. */
  adviceText?: string;
  /** Suggested advice tag, when present. */
  adviceTag?: string;
  /** Free-form gate values that drove the decision. */
  gateValues?: Record<string, string | number | boolean>;
}

/** Reservoir-sample cap for SessionStats.suppressedSamples. */
export const SUPPRESSED_SAMPLE_CAP = 50;

export interface SessionStats {
  /** Total advice envelopes delivered (any channel). */
  adviceDelivered: number;
  /** Advice delivered via Foundry. */
  adviceViaFoundry: number;
  /** Advice delivered via Discord (fallback). */
  adviceViaDiscord: number;
  /** Total suppressions (sum across suppressedByReason). */
  adviceSuppressed: number;
  /** QA #35: per-reason suppression counts. */
  suppressedByReason: Record<SuppressionReason, number>;
  /**
   * QA #35: bounded reservoir sample of suppressed candidates with the gate
   * values that drove the decision. Capped at {@link SUPPRESSED_SAMPLE_CAP}
   * — once full, new samples replace a uniformly random prior entry so the
   * sample stays representative across long sessions.
   */
  suppressedSamples: SuppressedSample[];
  /** Number of suppressions seen (used for reservoir sampling math). */
  suppressedSeenCount: number;
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
  /** v7: Beat reminders delivered. */
  beatRemindersDelivered: number;
  /** v7: Whisper-ready notifications delivered. */
  whisperNotificationsDelivered: number;
  /** v7: Whispers actually sent (via /send). */
  whispersSent: number;
}

/** Create a fresh stats object for a new session. */
export function createSessionStats(): SessionStats {
  return {
    adviceDelivered: 0,
    adviceViaFoundry: 0,
    adviceViaDiscord: 0,
    adviceSuppressed: 0,
    suppressedByReason: {
      already_covered: 0,
      duplicate: 0,
      timing_window: 0,
      below_confidence: 0,
    },
    suppressedSamples: [],
    suppressedSeenCount: 0,
    sessionStartedAt: null,
    activatedAt: null,
    activationSource: null,
    totalSegmentCount: 0,
    speakerDistribution: {},
    beatRemindersDelivered: 0,
    whisperNotificationsDelivered: 0,
    whispersSent: 0,
  };
}

/**
 * QA #35: record a suppression event into SessionStats. Increments the
 * per-reason bin and reservoir-samples the per-candidate detail.
 *
 * Reservoir sampling (Algorithm R): once the buffer is full, the kth sample
 * replaces a uniformly random prior entry with probability cap/k. Distribution
 * stays uniform across the full session even though we never see all
 * suppressions at once. Random draw injectable for deterministic tests.
 */
export function recordSuppression(
  stats: SessionStats,
  sample: SuppressedSample,
  random: () => number = Math.random,
): void {
  stats.suppressedByReason[sample.reason]++;
  stats.adviceSuppressed++;
  stats.suppressedSeenCount++;

  if (stats.suppressedSamples.length < SUPPRESSED_SAMPLE_CAP) {
    stats.suppressedSamples.push(sample);
    return;
  }
  const idx = Math.floor(random() * stats.suppressedSeenCount);
  if (idx < SUPPRESSED_SAMPLE_CAP) {
    stats.suppressedSamples[idx] = sample;
  }
}
