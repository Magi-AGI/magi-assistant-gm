/**
 * v2 Trigger detection and batching system.
 *
 * Replaces v1 heartbeat + regex questions with:
 * - P1-P4 priority triggers
 * - PREGAME/ACTIVE/SLEEP state machine
 * - Flowing-RP suppression
 * - 30s batch window (P1 flushes immediately)
 * - 180s cooldown between advice (P1 exempt)
 */

import { EventEmitter } from 'events';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import type { PacingStateManager } from '../state/pacing.js';
import {
  AssistantState,
  TriggerPriority,
  TriggerEvent,
  TriggerBatch,
} from '../types/index.js';

// ── P1 keyword patterns ────────────────────────────────────────────────────

const P1_KEYWORDS = [
  /what\s+should/i,
  /how\s+does/i,
  /remind\s+me/i,
  /what(?:'s| is)\s+the\s+rule/i,
  /what(?:'s| is)\s+the\s+name\s+of/i,
  /can\s+(?:i|they|we|he|she)\s+(?:do|use|invoke)/i,
  /how\s+(?:do|does|should)\s+(?:i|we)/i,
  /who\s+is/i,
  /where\s+is/i,
  /tell\s+me\s+about/i,
];

// ── P2 scene/act transition keywords ───────────────────────────────────────

const SCENE_TRANSITION_KEYWORDS = [
  /\bnext\s+scene\b/i,
  /\bmeanwhile\b/i,
  /\bcut\s+to\b/i,
  /\bscene\s+(?:change|transition|shift)\b/i,
  /\bback\s+at\b/i,
  /\belsewhere\b/i,
];

const ACT_TRANSITION_KEYWORDS = [
  /\bnext\s+act\b/i,
  /\bact\s+(?:two|three|2|3|ii|iii)\b/i,
  /\bintermission\b/i,
];

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_PENDING_EVENTS = 100;

/**
 * Minimum number of recent transcript segments from different speakers
 * within a window to consider "flowing RP" (suppresses P3/P4).
 */
const FLOWING_RP_MIN_SPEAKERS = 2;
const FLOWING_RP_MIN_SEGMENTS = 4;
const FLOWING_RP_WINDOW_MS = 60_000; // 60s

export interface TriggerDetectorEvents {
  trigger: [batch: TriggerBatch];
}

export class TriggerDetector extends EventEmitter<TriggerDetectorEvents> {
  private pendingEvents: TriggerEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushTime = 0;
  private deferredFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Track last GM speech timestamp for silence detection. */
  private lastGmSpeechTime = 0;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  /** P4 fires once per silence period. */
  private silenceAlertFired = false;

  /** Recent transcript segments for flowing-RP detection. */
  private recentSegments: Array<{ userId: string; timestamp: number }> = [];

  private readonly batchWindowMs: number;
  private readonly minIntervalMs: number;
  private readonly silenceThresholdMs: number;
  private readonly pacing: PacingStateManager;

  constructor(pacing: PacingStateManager) {
    super();
    const config = getConfig();
    this.batchWindowMs = config.eventBatchWindowSeconds * 1000;
    this.minIntervalMs = config.minAdviceIntervalSeconds * 1000;
    this.silenceThresholdMs = config.activeSilenceSeconds * 1000;
    this.pacing = pacing;
  }

  start(): void {
    const config = getConfig();

    // Silence detection: check every 10s
    this.silenceTimer = setInterval(() => {
      this.checkSilence();
    }, 10_000);

    logger.info(
      `TriggerDetector v2 started (batch=${config.eventBatchWindowSeconds}s, ` +
      `cooldown=${config.minAdviceIntervalSeconds}s, ` +
      `silence=${config.activeSilenceSeconds}s)`
    );
  }

  stop(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.deferredFlushTimer) {
      clearTimeout(this.deferredFlushTimer);
      this.deferredFlushTimer = null;
    }
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  // ── Transcript Ingestion ────────────────────────────────────────────────

  /**
   * Feed new FINAL transcript segments for trigger detection.
   * Called by the orchestrator after polling Discord transcript.
   */
  onTranscriptUpdate(segments: Array<{ text: string; userId?: string; displayName?: string; speakerLabel?: string; timestamp: string }>): void {
    const now = Date.now();
    const state = this.pacing.assistantState;

    const config = getConfig();
    const gmId = config.gmIdentifier.toLowerCase();

    for (const seg of segments) {
      // Fix #9: Only GM speech resets the silence timer.
      // Match against userId, displayName, OR speakerLabel (case-insensitive) to support:
      // - Group 1 (Discord): userId is a Discord snowflake
      // - Group 2 (diarization): speakerLabel is the raw diarization label (e.g. "speaker_1")
      // If gmIdentifier is not configured, fall back to tracking all speech.
      const isGmSpeech = !gmId ||
        seg.userId?.toLowerCase() === gmId ||
        seg.displayName?.toLowerCase() === gmId ||
        seg.speakerLabel?.toLowerCase() === gmId;
      if (isGmSpeech) {
        this.lastGmSpeechTime = now;
        this.silenceAlertFired = false;
      }

      // Track for flowing-RP detection
      // Use speakerLabel for diarized mode (where all speech shares one userId),
      // falling back to userId for per-user Discord mode.
      const speakerId = seg.speakerLabel ?? seg.userId;
      if (speakerId) {
        this.recentSegments.push({ userId: speakerId, timestamp: now });
      }

      // State transitions: only GM speech wakes from SLEEP.
      // If any speech woke the system, checkSilence() would immediately re-sleep
      // on the next tick because the GM is still "silent" — causing ping-pong.
      if (state === AssistantState.SLEEP && isGmSpeech) {
        this.pacing.transitionTo(AssistantState.ACTIVE);
        logger.info('TriggerDetector: SLEEP → ACTIVE (GM speech detected)');
      }

      // P1: GM question detection
      if (this.isP1Question(seg.text)) {
        logger.info(`TriggerDetector: P1 question — "${seg.text.trim().slice(0, 80)}"`);
        this.addEvent({
          type: 'gm_question',
          priority: TriggerPriority.P1,
          source: seg.userId ?? 'unknown',
          data: { transcript: seg.text },
          timestamp: seg.timestamp,
        });
      }

      // P2: Scene transition keywords
      if (state === AssistantState.ACTIVE && this.isSceneTransitionKeyword(seg.text)) {
        logger.info(`TriggerDetector: P2 scene transition keyword — "${seg.text.trim().slice(0, 80)}"`);
        this.addEvent({
          type: 'scene_transition',
          priority: TriggerPriority.P2,
          source: 'transcript',
          data: { transcript: seg.text },
          timestamp: seg.timestamp,
        });
      }

      // P2: Act transition keywords
      if (state === AssistantState.ACTIVE && this.isActTransitionKeyword(seg.text)) {
        logger.info(`TriggerDetector: P2 act transition keyword — "${seg.text.trim().slice(0, 80)}"`);
        this.addEvent({
          type: 'act_transition',
          priority: TriggerPriority.P2,
          source: 'transcript',
          data: { transcript: seg.text },
          timestamp: seg.timestamp,
        });
      }
    }

    // Prune old flowing-RP tracking data
    const cutoff = now - FLOWING_RP_WINDOW_MS;
    this.recentSegments = this.recentSegments.filter(s => s.timestamp > cutoff);
  }

  // ── Game Event Ingestion ────────────────────────────────────────────────

  /**
   * Feed Foundry game events for trigger detection.
   * Called by the orchestrator after polling Foundry state.
   */
  onGameEvent(eventType: string, data: Record<string, unknown>): void {
    const state = this.pacing.assistantState;

    // Scene change from Foundry → P2
    if (eventType === 'sceneChange') {
      // A Foundry scene change also transitions PREGAME → ACTIVE
      if (state === AssistantState.PREGAME) {
        this.pacing.transitionTo(AssistantState.ACTIVE);
        logger.info('TriggerDetector: PREGAME → ACTIVE (Foundry scene change)');
      }

      if (this.pacing.assistantState === AssistantState.ACTIVE) {
        this.addEvent({
          type: 'scene_transition',
          priority: TriggerPriority.P2,
          source: 'foundry',
          data,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    // Other game events are not trigger-worthy in v2
    // (combat, rolls, etc. are context data, not triggers)
  }

  // ── Silence Detection (P4) ──────────────────────────────────────────────

  private checkSilence(): void {
    const state = this.pacing.assistantState;
    if (state !== AssistantState.ACTIVE) return;
    if (this.silenceAlertFired) return;
    if (this.lastGmSpeechTime === 0) return;

    const now = Date.now();
    const silenceMs = now - this.lastGmSpeechTime;

    // Check for ACTIVE → SLEEP transition (15 min silence)
    const config = getConfig();
    const sleepThresholdMs = config.sleepSilenceMinutes * 60_000;
    if (silenceMs >= sleepThresholdMs) {
      this.pacing.transitionTo(AssistantState.SLEEP);
      logger.info(`TriggerDetector: ACTIVE → SLEEP (${config.sleepSilenceMinutes}m silence)`);
      return;
    }

    // P4: GM silence > threshold during active play
    if (silenceMs >= this.silenceThresholdMs) {
      // Suppress if flowing RP is happening
      if (this.isFlowingRP()) {
        logger.debug('TriggerDetector: P4 suppressed (flowing RP)');
        return;
      }

      this.silenceAlertFired = true;
      logger.info(`TriggerDetector: P4 silence detection (${Math.round(silenceMs / 1000)}s)`);
      this.addEvent({
        type: 'silence_detection',
        priority: TriggerPriority.P4,
        source: 'silence',
        data: { silenceSeconds: Math.round(silenceMs / 1000) },
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── Pacing Alert (P3) ───────────────────────────────────────────────────

  /**
   * Called by the orchestrator after updating pacing timers.
   * Checks if the current scene is overrunning.
   */
  checkPacingOverrun(thresholdMinutes: number): void {
    const state = this.pacing.assistantState;
    if (state !== AssistantState.ACTIVE) return;
    if (this.pacing.hasOverrunFired()) return;

    if (this.pacing.isSceneOverrun(thresholdMinutes)) {
      // Suppress if flowing RP is happening
      if (this.isFlowingRP()) {
        logger.debug('TriggerDetector: P3 suppressed (flowing RP)');
        return;
      }

      this.pacing.markOverrunFired();
      logger.info('TriggerDetector: P3 pacing alert (scene overrun)');
      this.addEvent({
        type: 'pacing_alert',
        priority: TriggerPriority.P3,
        source: 'pacing',
        data: {
          scene: this.pacing.state.current_scene,
          elapsed: this.pacing.state.scene_timing.elapsed_minutes,
          planned: this.pacing.state.scene_timing.planned_max_minutes,
        },
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── Event Queue & Batching ──────────────────────────────────────────────

  private addEvent(event: TriggerEvent): void {
    const state = this.pacing.assistantState;

    // PREGAME and SLEEP: only P1 triggers pass through
    if (
      (state === AssistantState.PREGAME || state === AssistantState.SLEEP) &&
      event.priority !== TriggerPriority.P1
    ) {
      logger.debug(`TriggerDetector: suppressing ${event.type} in ${state}`);
      return;
    }

    // Cap queue size: drop oldest lowest-priority event when full
    if (this.pendingEvents.length >= MAX_PENDING_EVENTS) {
      let lowestIdx = 0;
      for (let i = 1; i < this.pendingEvents.length; i++) {
        // Higher priority number = lower importance in v2 (P1 > P4)
        if (this.pendingEvents[i].priority > this.pendingEvents[lowestIdx].priority) {
          lowestIdx = i;
        }
      }
      // Only drop if new event is higher priority (lower number)
      if (event.priority < this.pendingEvents[lowestIdx].priority) {
        this.pendingEvents.splice(lowestIdx, 1);
      } else {
        logger.debug('TriggerDetector: dropping event (queue full)');
        return;
      }
    }

    this.pendingEvents.push(event);

    // P1: immediate flush, no batching
    if (event.priority === TriggerPriority.P1) {
      this.flush();
      return;
    }

    // Start batch window if not already running
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        this.flush();
      }, this.batchWindowMs);
    }
  }

  private flush(): void {
    if (this.pendingEvents.length === 0) return;

    const now = Date.now();
    const timeSinceLastFlush = now - this.lastFlushTime;

    // P1 and P2 exempt from 180s cooldown — determined dynamically so a late-arriving
    // P2 in a mixed batch isn't shadowed by a P3/P4 that started the batch timer.
    const cooldownExempt = this.pendingEvents.some(
      e => e.priority === TriggerPriority.P1 || e.priority === TriggerPriority.P2
    );

    if (!cooldownExempt && timeSinceLastFlush < this.minIntervalMs) {
      if (!this.deferredFlushTimer) {
        const delay = this.minIntervalMs - timeSinceLastFlush;
        logger.debug(`TriggerDetector: deferring flush by ${delay}ms (rate limit)`);
        this.deferredFlushTimer = setTimeout(() => {
          this.deferredFlushTimer = null;
          this.flush();
        }, delay);
      }
      return;
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Arbitrate: sort by priority (P1 first), then by timestamp (earliest first)
    this.pendingEvents.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.timestamp.localeCompare(b.timestamp);
    });

    const batch: TriggerBatch = {
      events: this.pendingEvents.splice(0),
      flushedAt: new Date().toISOString(),
    };

    this.lastFlushTime = now;

    const priorities = batch.events.map(e => `P${e.priority}`).join(', ');
    logger.info(`TriggerDetector: flushing ${batch.events.length} events [${priorities}]`);
    this.emit('trigger', batch);
  }

  // ── Detection Helpers ───────────────────────────────────────────────────

  private isP1Question(text: string): boolean {
    const trimmed = text.trim().toLowerCase();
    return P1_KEYWORDS.some(pattern => pattern.test(trimmed));
  }

  private isSceneTransitionKeyword(text: string): boolean {
    return SCENE_TRANSITION_KEYWORDS.some(pattern => pattern.test(text));
  }

  private isActTransitionKeyword(text: string): boolean {
    return ACT_TRANSITION_KEYWORDS.some(pattern => pattern.test(text));
  }

  /**
   * Detect "flowing RP" — active back-and-forth dialogue between players.
   * Suppresses P3/P4 to avoid interrupting engaged play.
   * Filters by timestamp to avoid stale data when called from checkSilence()
   * (which runs on a timer independent of transcript updates).
   */
  private isFlowingRP(): boolean {
    const cutoff = Date.now() - FLOWING_RP_WINDOW_MS;
    const recent = this.recentSegments.filter(s => s.timestamp > cutoff);
    if (recent.length < FLOWING_RP_MIN_SEGMENTS) return false;
    const uniqueSpeakers = new Set(recent.map(s => s.userId));
    return uniqueSpeakers.size >= FLOWING_RP_MIN_SPEAKERS;
  }
}
