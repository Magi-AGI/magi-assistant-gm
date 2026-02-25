/**
 * v3 Trigger detection and batching system.
 *
 * v2 base: P1-P4 priority triggers, PREGAME/ACTIVE/SLEEP state machine,
 * flowing-RP suppression, 30s batch window (P1 flushes immediately),
 * 180s cooldown between advice (P1/P2 exempt).
 *
 * v3 additions:
 * - Auto-ACTIVE: transcript-based PREGAME→ACTIVE fallback (proper noun detection)
 * - NPC first-appearance: P2 trigger on first mention of a cached NPC
 * - Scene keyword matching: P2 trigger when transcript matches scene index
 * - Pacing gates: P2 convergence/denouement triggers on wall-clock time
 */

import { readFileSync } from 'node:fs';
import { EventEmitter } from 'events';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import type { PacingStateManager } from '../state/pacing.js';
import type { NpcCacheEntry, SceneIndexEntry, ActivationSource } from '../types/index.js';
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

const FLOWING_RP_MIN_SPEAKERS = 2;
const FLOWING_RP_MIN_SEGMENTS = 4;
const FLOWING_RP_WINDOW_MS = 60_000; // 60s

/** v3: Minimum delay between scene index match triggers for the same scene. */
const SCENE_MATCH_WINDOW_MS = 3 * 60_000; // 3 minutes

export interface TriggerDetectorEvents {
  trigger: [batch: TriggerBatch];
  /** v3: Emitted when PREGAME→ACTIVE should occur. Orchestrator handles transition + cache build. */
  activated: [source: ActivationSource];
}

/**
 * Fuzzy match table: maps garbled STT forms → canonical terms.
 * Loaded from config/fuzzy-match.json. Used for auto-ACTIVE detection
 * and NPC cache lookups.
 */
export type FuzzyMatchTable = Record<string, string>;

/**
 * Load and parse the fuzzy match table from a JSON file path.
 * Returns empty table on failure (non-blocking).
 */
export function loadFuzzyMatchTable(path: string): FuzzyMatchTable {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      // Filter out _comment keys
      const table: FuzzyMatchTable = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith('_')) continue;
        if (typeof value === 'string') {
          table[key.toLowerCase()] = value.toLowerCase();
        }
      }
      logger.info(`Loaded ${Object.keys(table).length} fuzzy match entries from ${path}`);
      return table;
    }
  } catch (err) {
    logger.warn(`Failed to load fuzzy match table from ${path}:`, err);
  }
  return {};
}

/** Build a word-boundary regex for a search term. */
function wordBoundaryRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`);
}

interface ActivationEntry {
  canonical: string;
  pattern: RegExp;
}

/**
 * Build the activation dictionary from the fuzzy match table.
 * Returns a map of search term → { canonical, pre-compiled regex }.
 * Search terms include both garbled forms (keys) and canonical forms (values).
 */
function buildActivationDictionary(
  fuzzyTable: FuzzyMatchTable,
  minTermLength: number,
): Map<string, ActivationEntry> {
  const dict = new Map<string, ActivationEntry>();

  for (const [garbled, canonical] of Object.entries(fuzzyTable)) {
    // Add garbled form → canonical
    if (garbled.length >= minTermLength) {
      dict.set(garbled, { canonical, pattern: wordBoundaryRegex(garbled) });
    }
    // Add canonical form → itself
    if (canonical.length >= minTermLength && !dict.has(canonical)) {
      dict.set(canonical, { canonical, pattern: wordBoundaryRegex(canonical) });
    }
  }

  return dict;
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

  // ── v3: P1-H hesitation state ───────────────────────────────────────────

  /** Timestamp when GM last spoke a hesitation keyword. */
  private lastHesitationTime = 0;
  /** Text of the last GM segment containing a hesitation keyword. */
  private lastHesitationText = '';
  /** Prevents re-firing until GM speaks again. */
  private hesitationFired = false;
  private readonly hesitationSilenceMs: number;
  private readonly hesitationPatterns: RegExp[];

  /** Recent transcript segments for flowing-RP detection. */
  private recentSegments: Array<{ userId: string; timestamp: number }> = [];

  private readonly batchWindowMs: number;
  private readonly minIntervalMs: number;
  private readonly silenceThresholdMs: number;
  private readonly pacing: PacingStateManager;

  // ── v3: Auto-ACTIVE state ──────────────────────────────────────────────

  private fuzzyTable: FuzzyMatchTable = {};
  /** Map: search term (lowercase) → { canonical, pre-compiled pattern }. */
  private activationDict = new Map<string, ActivationEntry>();
  /** Rolling window of detected canonical terms with timestamps. */
  private activationWindow: Array<{ canonical: string; timestamp: number }> = [];
  private readonly autoActiveEnabled: boolean;
  private readonly autoActiveWindowMs: number;
  private readonly autoActiveThreshold: number;

  // ── v3: NPC cache + scene index references (set by orchestrator) ───────

  private npcCache: NpcCacheEntry[] = [];
  private sceneIndex: SceneIndexEntry[] = [];
  /** Track accumulated keyword matches per scene within a rolling window. */
  private sceneMatchState = new Map<string, { keywords: Set<string>; windowStart: number }>();

  // ── v3: Pacing gates state ─────────────────────────────────────────────

  private convergenceGateFired = false;
  private convergenceEscalationFired = false;
  private denouementGateFired = false;

  constructor(pacing: PacingStateManager, fuzzyTable?: FuzzyMatchTable) {
    super();
    const config = getConfig();
    this.batchWindowMs = config.eventBatchWindowSeconds * 1000;
    this.minIntervalMs = config.minAdviceIntervalSeconds * 1000;
    this.silenceThresholdMs = config.activeSilenceSeconds * 1000;
    this.pacing = pacing;

    // v3: auto-ACTIVE config
    this.autoActiveEnabled = config.autoActiveEnabled;
    this.autoActiveWindowMs = config.autoActiveWindowMinutes * 60_000;
    this.autoActiveThreshold = config.autoActiveThreshold;

    // v3: P1-H hesitation config (pre-compile patterns)
    this.hesitationSilenceMs = config.hesitationSilenceSeconds * 1000;
    this.hesitationPatterns = config.hesitationKeywords.map(kw => {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i');
    });

    // v3: load fuzzy match table
    if (fuzzyTable) {
      this.fuzzyTable = fuzzyTable;
    }
    this.activationDict = buildActivationDictionary(
      this.fuzzyTable,
      config.autoActiveMinTermLength,
    );
    if (this.activationDict.size > 0) {
      logger.info(`TriggerDetector: activation dictionary has ${this.activationDict.size} terms`);
    }
  }

  start(): void {
    const config = getConfig();

    // Silence + hesitation detection: check every 10s
    this.silenceTimer = setInterval(() => {
      this.checkHesitation();
      this.checkSilence();
      this.checkPacingGates();
    }, 10_000);

    logger.info(
      `TriggerDetector started (batch=${config.eventBatchWindowSeconds}s, ` +
      `cooldown=${config.minAdviceIntervalSeconds}s, ` +
      `silence=${config.activeSilenceSeconds}s, ` +
      `auto-active=${this.autoActiveEnabled ? `${config.autoActiveThreshold} terms in ${config.autoActiveWindowMinutes}min` : 'disabled'})`
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

  // ── v3: Resource setters (called by orchestrator after build) ──────────

  setNpcCache(cache: NpcCacheEntry[]): void {
    this.npcCache = cache;
    logger.info(`TriggerDetector: NPC cache loaded (${cache.length} entries)`);
  }

  setSceneIndex(index: SceneIndexEntry[]): void {
    this.sceneIndex = index;
    logger.info(`TriggerDetector: scene index loaded (${index.length} entries)`);
  }

  getFuzzyTable(): FuzzyMatchTable {
    return this.fuzzyTable;
  }

  /**
   * v3: Backfill NPC first-appearance checks over recent transcript segments.
   * Called after the NPC cache finishes building to catch any mentions that
   * arrived during the async build window.
   */
  backfillNpcMentions(segments: Array<{ text: string; timestamp: string }>): void {
    if (this.npcCache.length === 0) return;
    let backfilled = 0;
    for (const seg of segments) {
      this.checkNpcFirstAppearance(seg.text, seg.timestamp);
      if (this.npcCache.every(n => n.served)) break; // All served, stop early
    }
    backfilled = this.npcCache.filter(n => n.served).length;
    if (backfilled > 0) {
      logger.info(`TriggerDetector: backfilled ${backfilled} NPC mentions from transcript cache`);
    }
  }

  // ── Transcript Ingestion ────────────────────────────────────────────────

  /**
   * Feed new FINAL transcript segments for trigger detection.
   * Called by the orchestrator after polling Discord transcript.
   */
  onTranscriptUpdate(segments: Array<{ text: string; userId?: string; displayName?: string; speakerLabel?: string; timestamp: string }>): void {
    const now = Date.now();

    const config = getConfig();
    const gmId = config.gmIdentifier.toLowerCase();

    for (const seg of segments) {
      // Re-read state each iteration — auto-ACTIVE or other handlers may
      // transition state mid-loop (fixes stale-state / duplicate-activated bug).
      const state = this.pacing.assistantState;

      // Fix #9: Only GM speech resets the silence timer.
      const isGmSpeech = !gmId ||
        seg.userId?.toLowerCase() === gmId ||
        seg.displayName?.toLowerCase() === gmId ||
        seg.speakerLabel?.toLowerCase() === gmId;
      if (isGmSpeech) {
        this.lastGmSpeechTime = now;
        this.silenceAlertFired = false;
        this.hesitationFired = false; // Reset on new GM speech

        // v3: P1-H — track hesitation keywords.
        // If the segment contains a hesitation keyword, start tracking.
        // If it does NOT, clear the pending hesitation — the GM continued
        // speaking, so there's no gap to fill. This also prevents false-fires
        // when a hesitation segment and a normal segment arrive in the same
        // poll batch (same `now` value).
        if (this.isHesitationKeyword(seg.text)) {
          this.lastHesitationTime = now;
          this.lastHesitationText = seg.text;
        } else if (seg.text.trim().length > 0) {
          this.lastHesitationTime = 0;
        }
      }

      // Track for flowing-RP detection
      const speakerId = seg.speakerLabel ?? seg.userId;
      if (speakerId) {
        this.recentSegments.push({ userId: speakerId, timestamp: now });
      }

      // State transitions: only GM speech wakes from SLEEP.
      if (state === AssistantState.SLEEP && isGmSpeech) {
        this.pacing.transitionTo(AssistantState.ACTIVE);
        logger.info('TriggerDetector: SLEEP → ACTIVE (GM speech detected)');
      }

      // v3: Auto-ACTIVE detection (PREGAME only)
      if (state === AssistantState.PREGAME && this.autoActiveEnabled) {
        this.checkAutoActive(seg.text, now);
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

      // P2: Scene transition keywords (ACTIVE only)
      if (this.pacing.assistantState === AssistantState.ACTIVE && this.isSceneTransitionKeyword(seg.text)) {
        logger.info(`TriggerDetector: P2 scene transition keyword — "${seg.text.trim().slice(0, 80)}"`);
        this.addEvent({
          type: 'scene_transition',
          priority: TriggerPriority.P2,
          source: 'transcript',
          data: { transcript: seg.text },
          timestamp: seg.timestamp,
        });
      }

      // P2: Act transition keywords (ACTIVE only)
      if (this.pacing.assistantState === AssistantState.ACTIVE && this.isActTransitionKeyword(seg.text)) {
        logger.info(`TriggerDetector: P2 act transition keyword — "${seg.text.trim().slice(0, 80)}"`);
        this.addEvent({
          type: 'act_transition',
          priority: TriggerPriority.P2,
          source: 'transcript',
          data: { transcript: seg.text },
          timestamp: seg.timestamp,
        });
      }

      // v3: NPC first-appearance detection (ACTIVE only, requires NPC cache)
      if (this.pacing.assistantState === AssistantState.ACTIVE && this.npcCache.length > 0) {
        this.checkNpcFirstAppearance(seg.text, seg.timestamp);
      }

      // v3: Scene keyword matching (ACTIVE only, requires scene index)
      if (this.pacing.assistantState === AssistantState.ACTIVE && this.sceneIndex.length > 0) {
        this.checkSceneKeywordMatch(seg.text, seg.timestamp, now);
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
      // v3: PREGAME → ACTIVE via Foundry scene change — notify orchestrator.
      // The orchestrator's handleActivation() runs synchronously (no awaits),
      // so state is ACTIVE by the time emit() returns, and the P2 event
      // below fires in ACTIVE state instead of being suppressed.
      if (state === AssistantState.PREGAME) {
        this.emit('activated', 'foundry' as ActivationSource);
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
  }

  // ── v3: Auto-ACTIVE Detection ──────────────────────────────────────────

  /**
   * Check if transcript segment contains campaign proper nouns.
   * When ≥threshold distinct terms are detected in the rolling window,
   * emit 'activated' so the orchestrator can transition to ACTIVE.
   */
  private checkAutoActive(text: string, now: number): void {
    const textLower = text.toLowerCase();

    // Check each activation term against the text (pre-compiled word-boundary regex)
    for (const [, entry] of this.activationDict) {
      if (entry.pattern.test(textLower)) {
        this.activationWindow.push({ canonical: entry.canonical, timestamp: now });
      }
    }

    // Prune entries outside the rolling window
    const windowCutoff = now - this.autoActiveWindowMs;
    this.activationWindow = this.activationWindow.filter(e => e.timestamp > windowCutoff);

    // Count distinct canonical terms in the window
    const distinctTerms = new Set(this.activationWindow.map(e => e.canonical));
    if (distinctTerms.size >= this.autoActiveThreshold) {
      const terms = [...distinctTerms].join(', ');
      logger.info(`TriggerDetector: auto-ACTIVE triggered (${distinctTerms.size} terms: ${terms})`);
      this.activationWindow = []; // Reset window
      this.emit('activated', 'transcript' as ActivationSource);
    }
  }

  // ── v3: NPC First-Appearance Detection ─────────────────────────────────

  /**
   * Check if any unserved NPC from the cache is mentioned in this segment.
   * Matches against display name, key, and aliases (including fuzzy match forms).
   */
  private checkNpcFirstAppearance(text: string, timestamp: string): void {
    const textLower = text.toLowerCase();

    for (const npc of this.npcCache) {
      if (npc.served) continue;

      // Check against all aliases with word boundaries (prevents "vel" matching "velvet")
      const matched = npc.aliases.some(alias => wordBoundaryRegex(alias).test(textLower));
      if (!matched) {
        // Also check fuzzy match table: garbled forms that map to this NPC
        const fuzzyMatched = Object.entries(this.fuzzyTable).some(
          ([garbled, canonical]) => canonical === npc.key && wordBoundaryRegex(garbled).test(textLower)
        );
        if (!fuzzyMatched) continue;
      }

      npc.served = true;
      npc.last_served_at = new Date().toISOString();
      logger.info(`TriggerDetector: P2 NPC first appearance — ${npc.display_name}`);
      this.addEvent({
        type: 'npc_first_appearance',
        priority: TriggerPriority.P2,
        source: 'npc-cache',
        data: {
          npc_key: npc.key,
          npc_name: npc.display_name,
          npc_brief: npc.brief,
          npc_pronunciation: npc.pronunciation,
          npc_card: npc.full_card,
        },
        timestamp,
      });
    }
  }

  // ── v3: Scene Keyword Matching ─────────────────────────────────────────

  /**
   * Check if transcript matches keywords from an unserved scene in the index.
   * Accumulates distinct keyword matches per scene across segments within
   * SCENE_MATCH_WINDOW_MS. Triggers when ≥2 distinct keywords are matched.
   */
  private checkSceneKeywordMatch(text: string, timestamp: string, now: number): void {
    const textLower = text.toLowerCase();

    for (const scene of this.sceneIndex) {
      if (scene.served) continue;

      // Find keywords from this scene that appear in this segment (word boundary check)
      const matchedKeywords = scene.keywords.filter(kw => wordBoundaryRegex(kw).test(textLower));
      if (matchedKeywords.length === 0) continue;

      // Get or create match state for this scene
      let matchState = this.sceneMatchState.get(scene.id);
      if (!matchState || now - matchState.windowStart > SCENE_MATCH_WINDOW_MS) {
        // Start a new match window
        matchState = { keywords: new Set<string>(), windowStart: now };
        this.sceneMatchState.set(scene.id, matchState);
      }

      // Accumulate distinct keywords across segments
      for (const kw of matchedKeywords) {
        matchState.keywords.add(kw);
      }

      // Need ≥2 distinct keywords to trigger
      if (matchState.keywords.size >= 2) {
        scene.served = true;
        scene.served_at = new Date().toISOString();
        const allMatched = [...matchState.keywords];
        this.sceneMatchState.delete(scene.id);
        logger.info(`TriggerDetector: P2 scene detected — "${scene.title}" (keywords: ${allMatched.join(', ')})`);
        this.addEvent({
          type: 'scene_transition_detected',
          priority: TriggerPriority.P2,
          source: 'scene-index',
          data: {
            scene_id: scene.id,
            scene_title: scene.title,
            scene_card: scene.card,
            matched_keywords: allMatched,
          },
          timestamp,
        });
      }
    }
  }

  // ── v3: Pacing Gates ───────────────────────────────────────────────────

  /**
   * Check wall-clock time against session end time for convergence/denouement gates.
   * Called from the 10s interval timer (alongside checkSilence).
   */
  private checkPacingGates(): void {
    if (this.pacing.assistantState !== AssistantState.ACTIVE) return;

    const sessionEndTime = this.pacing.state.session_end_time;
    if (!sessionEndTime) return;

    const config = getConfig();
    const now = Date.now();
    const endMs = new Date(sessionEndTime).getTime();
    if (!Number.isFinite(endMs)) return;

    const remainingMs = endMs - now;
    const remainingMin = Math.round(remainingMs / 60_000);

    // Convergence gate: SESSION_END_TIME - convergenceGateMinutes
    const convergenceMs = config.convergenceGateMinutes * 60_000;
    if (!this.convergenceGateFired && remainingMs <= convergenceMs && remainingMs > 0) {
      this.convergenceGateFired = true;
      logger.info(`TriggerDetector: P2 convergence gate (${remainingMin} min remaining)`);
      this.addEvent({
        type: 'pacing_gate_convergence',
        priority: TriggerPriority.P2,
        source: 'pacing-gate',
        data: {
          remaining_minutes: remainingMin,
          session_end_time: sessionEndTime,
          open_threads: this.pacing.state.open_threads,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Convergence escalation: if act 3 hasn't started within 10 min of gate
    if (this.convergenceGateFired && !this.convergenceEscalationFired) {
      const timeSinceGate = convergenceMs - remainingMs;
      if (timeSinceGate > 10 * 60_000 && this.pacing.state.current_act < 3) {
        this.convergenceEscalationFired = true;
        logger.info(`TriggerDetector: P2 convergence escalation (${remainingMin} min remaining, still in Act ${this.pacing.state.current_act})`);
        this.addEvent({
          type: 'pacing_gate_convergence',
          priority: TriggerPriority.P2,
          source: 'pacing-gate',
          data: {
            remaining_minutes: remainingMin,
            session_end_time: sessionEndTime,
            escalation: true,
            current_act: this.pacing.state.current_act,
          },
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Denouement gate: SESSION_END_TIME - denouementGateMinutes
    const denouementMs = config.denouementGateMinutes * 60_000;
    if (!this.denouementGateFired && remainingMs <= denouementMs && remainingMs > 0) {
      this.denouementGateFired = true;
      logger.info(`TriggerDetector: P2 denouement gate (${remainingMin} min remaining)`);
      this.addEvent({
        type: 'pacing_gate_denouement',
        priority: TriggerPriority.P2,
        source: 'pacing-gate',
        data: {
          remaining_minutes: remainingMin,
          session_end_time: sessionEndTime,
        },
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── v3: Hesitation Detection (P1-H) ─────────────────────────────────────

  /** Check if text contains a hesitation keyword (pre-compiled patterns). */
  private isHesitationKeyword(text: string): boolean {
    return this.hesitationPatterns.some(p => p.test(text));
  }

  /**
   * P1-H: If GM's last speech contained a hesitation keyword and they've been
   * silent for ≥hesitationSilenceMs, fire a gap-fill trigger.
   */
  private checkHesitation(): void {
    if (this.pacing.assistantState !== AssistantState.ACTIVE) return;
    if (this.hesitationFired) return;
    if (this.lastHesitationTime === 0) return;

    // Only fire if the last GM speech was the hesitation (GM hasn't spoken since)
    if (this.lastHesitationTime !== this.lastGmSpeechTime) return;

    const now = Date.now();
    const silenceMs = now - this.lastHesitationTime;
    if (silenceMs >= this.hesitationSilenceMs) {
      this.hesitationFired = true;
      logger.info(`TriggerDetector: P1-H hesitation (${Math.round(silenceMs / 1000)}s silence after "${this.lastHesitationText.slice(0, 80)}")`);
      this.addEvent({
        type: 'gm_hesitation',
        priority: TriggerPriority.P1,
        source: 'hesitation',
        data: {
          transcript: this.lastHesitationText,
          silenceSeconds: Math.round(silenceMs / 1000),
        },
        timestamp: new Date().toISOString(),
      });
    }
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
        if (this.pendingEvents[i].priority > this.pendingEvents[lowestIdx].priority) {
          lowestIdx = i;
        }
      }
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

    // P1 and P2 exempt from 180s cooldown
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
   */
  private isFlowingRP(): boolean {
    const cutoff = Date.now() - FLOWING_RP_WINDOW_MS;
    const recent = this.recentSegments.filter(s => s.timestamp > cutoff);
    if (recent.length < FLOWING_RP_MIN_SEGMENTS) return false;
    const uniqueSpeakers = new Set(recent.map(s => s.userId));
    return uniqueSpeakers.size >= FLOWING_RP_MIN_SPEAKERS;
  }
}
