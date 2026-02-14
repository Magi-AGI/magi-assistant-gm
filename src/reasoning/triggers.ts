/**
 * Trigger detection and batching system.
 * Detects questions from transcripts, classifies game events, fires heartbeats.
 * Batches low-priority events, immediately flushes high-priority ones.
 */

import { EventEmitter } from 'events';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import type { TriggerEvent, TriggerBatch } from '../types/index.js';

const INTERROGATIVE_WORDS = /^\s*(who|what|where|when|why|how|can|should|could|would|does|did|is|are|was|were)\b/i;
const MAX_PENDING_EVENTS = 100;

export interface TriggerDetectorEvents {
  trigger: [batch: TriggerBatch];
}

export class TriggerDetector extends EventEmitter<TriggerDetectorEvents> {
  private pendingEvents: TriggerEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastFlushTime = 0;
  private deferredFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly batchWindowMs: number;
  private readonly minIntervalMs = 60_000; // 60s minimum between advice invocations

  constructor() {
    super();
    const config = getConfig();
    this.batchWindowMs = config.eventBatchWindowSeconds * 1000;
  }

  start(): void {
    const config = getConfig();
    // Heartbeat timer
    this.heartbeatTimer = setInterval(() => {
      this.addEvent({
        type: 'heartbeat',
        source: 'timer',
        priority: 1,
        data: {},
        timestamp: new Date().toISOString(),
      });
    }, config.heartbeatIntervalMinutes * 60_000);

    logger.info(`TriggerDetector started (heartbeat every ${config.heartbeatIntervalMinutes}m, batch window ${config.eventBatchWindowSeconds}s)`);
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.deferredFlushTimer) {
      clearTimeout(this.deferredFlushTimer);
      this.deferredFlushTimer = null;
    }
  }

  /** Feed new transcript segments for question detection. */
  onTranscriptUpdate(segments: Array<{ text: string; userId?: string; timestamp: string }>): void {
    for (const seg of segments) {
      if (this.isQuestion(seg.text)) {
        logger.info(`TriggerDetector: question detected — "${seg.text.trim().slice(0, 80)}" (userId=${seg.userId ?? 'unknown'})`);
        this.addEvent({
          type: 'question',
          source: seg.userId ?? 'unknown',
          priority: 4,
          data: { transcript: seg.text },
          timestamp: seg.timestamp,
        });
      }
    }
  }

  /** Feed game events from Foundry bridge. */
  onGameEvent(eventType: string, data: Record<string, unknown>): void {
    let priority: number;
    switch (eventType) {
      case 'combatUpdate':
        priority = 3;
        break;
      case 'stressChange':
      case 'consequenceChange':
        priority = 3;
        break;
      case 'chatMessage':
        // Only rolls are notable game events
        if (data.hasRoll) {
          priority = 2;
        } else {
          return; // Ignore regular chat
        }
        break;
      case 'sceneChange':
        priority = 2;
        break;
      default:
        priority = 1;
    }

    this.addEvent({
      type: 'game_event',
      source: eventType,
      priority,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  /** Manually trigger an on-demand advice request. */
  requestAdvice(context: string): void {
    this.addEvent({
      type: 'on_demand',
      source: 'manual',
      priority: 5,
      data: { context },
      timestamp: new Date().toISOString(),
    });
  }

  private addEvent(event: TriggerEvent): void {
    // Cap queue size: drop oldest low-priority events when full
    if (this.pendingEvents.length >= MAX_PENDING_EVENTS) {
      // Remove the oldest lowest-priority event to make room
      let lowestIdx = 0;
      for (let i = 1; i < this.pendingEvents.length; i++) {
        if (this.pendingEvents[i].priority < this.pendingEvents[lowestIdx].priority) {
          lowestIdx = i;
        }
      }
      if (this.pendingEvents[lowestIdx].priority < event.priority) {
        this.pendingEvents.splice(lowestIdx, 1);
      } else {
        // New event is lower priority than everything in queue — drop it
        logger.debug('TriggerDetector: dropping low-priority event (queue full)');
        return;
      }
    }

    this.pendingEvents.push(event);

    // Immediate flush for high priority (>= 4)
    if (event.priority >= 4) {
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

    // Rate limit: defer if too soon (but don't drop)
    if (timeSinceLastFlush < this.minIntervalMs) {
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

    const batch: TriggerBatch = {
      events: this.pendingEvents.splice(0),
      flushedAt: new Date().toISOString(),
    };

    this.lastFlushTime = now;

    logger.info(`TriggerDetector: flushing ${batch.events.length} events (max priority: ${Math.max(...batch.events.map((e) => e.priority))})`);
    this.emit('trigger', batch);
  }

  private isQuestion(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.endsWith('?')) return true;
    // Check for interrogative words at the start of any sentence in the segment
    // (players often narrate an action then ask a question: "I look around. Can I see anything?")
    const sentences = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    for (const sentence of sentences) {
      if (INTERROGATIVE_WORDS.test(sentence.trim()) && trimmed.length > 10) {
        return true;
      }
    }
    return false;
  }
}
