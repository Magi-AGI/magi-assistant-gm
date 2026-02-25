/**
 * Magi GM Assistant v3 — Event-driven orchestrator.
 *
 * v2 base: P1-P4 priority triggers, PREGAME/ACTIVE/SLEEP state machine,
 * wiki hard gate, image queue, GM command parsing.
 *
 * v3 additions:
 * - Auto-ACTIVE: transcript-based PREGAME→ACTIVE fallback
 * - ACTIVE initialization: NPC pre-cache + scene index build (async, non-blocking)
 * - Pacing gates: convergence/denouement triggers on wall-clock time
 * - GM commands: /endtime, /npc refresh, /npc serve
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { getConfig } from './config.js';
import { logger } from './logger.js';
import { McpAggregator } from './mcp/client.js';
import { PacingStateManager } from './state/pacing.js';
import { AdviceMemoryBuffer } from './state/advice-memory.js';
import { TriggerDetector, loadFuzzyMatchTable } from './reasoning/triggers.js';
import { ReasoningEngine } from './reasoning/engine.js';
import { NpcCacheBuilder } from './reasoning/npc-cache.js';
import { SceneIndexBuilder } from './reasoning/scene-index.js';
import { AdviceDelivery } from './output/index.js';
import { ImageQueue } from './output/image-queue.js';
import { parseGmCommand } from './state/gm-commands.js';
import { AssistantState } from './types/index.js';
import type { ActivationSource, NpcCacheEntry, SceneIndexEntry } from './types/index.js';

const config = getConfig();

// ── Core components ────────────────────────────────────────────────────────

const mcp = new McpAggregator();
const pacing = new PacingStateManager();
const memory = new AdviceMemoryBuffer(config.adviceMemorySize);
const imageQueue = new ImageQueue();

let triggers: TriggerDetector | null = null;
let engine: ReasoningEngine | null = null;
let delivery: AdviceDelivery | null = null;

// v3: Cache state
let npcCache: NpcCacheEntry[] = [];
let sceneIndex: SceneIndexEntry[] = [];
let activationBuildInProgress = false;

// ── Polling state ──────────────────────────────────────────────────────────

let transcriptPollTimer: ReturnType<typeof setInterval> | null = null;
let gameStatePollTimer: ReturnType<typeof setInterval> | null = null;
let pacingUpdateTimer: ReturnType<typeof setInterval> | null = null;
let lastTranscriptRowId = 0;
let lastSessionId: string | null = null;
let lastSceneId: string | null = null;
let lastSeenChatMsgId: string | null = null;
let transcriptPollInFlight = false;
let gameStatePollInFlight = false;
let lastTextEventId = 0;
let sessionJustChanged = false;

// Local transcript cache — ring buffer of recent segments
const TRANSCRIPT_CACHE_SIZE = 500;
interface CachedSegment {
  rowId: number;
  text: string;
  userId?: string;
  displayName?: string;
  speakerLabel?: string;
  timestamp: string;
}
const transcriptCache: CachedSegment[] = [];

// ── Graceful shutdown ──────────────────────────────────────────────────────

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal} — starting graceful shutdown...`);

  try {
    if (transcriptPollTimer) clearInterval(transcriptPollTimer);
    if (gameStatePollTimer) clearInterval(gameStatePollTimer);
    if (pacingUpdateTimer) clearInterval(pacingUpdateTimer);
    transcriptPollTimer = null;
    gameStatePollTimer = null;
    pacingUpdateTimer = null;

    if (triggers) triggers.stop();
    await mcp.disconnect();
    logger.info('Shutdown complete. Goodbye.');
  } catch (err) {
    logger.error('Error during shutdown:', err);
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});

// ── v3: ACTIVE Initialization ─────────────────────────────────────────────

/**
 * Handle transition to ACTIVE state from any source.
 * Centralizes state transition + async cache build so all activation paths
 * (Foundry scene change, /scene command, /act command, auto-ACTIVE)
 * go through one function.
 */
async function handleActivation(source: ActivationSource): Promise<void> {
  const prevState = pacing.assistantState;
  if (prevState !== AssistantState.PREGAME) {
    if (prevState === AssistantState.SLEEP) {
      pacing.transitionTo(AssistantState.ACTIVE);
      pacing.setActivationSource(source);
      logger.info(`Orchestrator: SLEEP → ACTIVE (${source})`);
    }
    // If caches failed or were never built, rebuild them
    const cacheMissing = npcCache.length === 0 && sceneIndex.length === 0;
    const cacheError = pacing.state.npc_cache_status === 'error' || pacing.state.scene_index_status === 'error';
    if ((cacheMissing || cacheError) && config.campaignWikiCard && !activationBuildInProgress) {
      logger.info('Orchestrator: rebuilding caches (missing or errored)');
      activationBuildInProgress = true;
      buildActivationCaches(config.campaignWikiCard).catch(err => {
        logger.error('Orchestrator: activation cache rebuild failed:', err);
      }).finally(() => {
        activationBuildInProgress = false;
      });
    }
    return;
  }

  // PREGAME → ACTIVE
  pacing.transitionTo(AssistantState.ACTIVE);
  pacing.setActivationSource(source);
  logger.info(`Orchestrator: PREGAME → ACTIVE (${source})`);

  // Set session end time from config if available
  if (config.sessionEndTime) {
    const endTime = parseSessionEndTime(config.sessionEndTime);
    if (endTime) {
      pacing.setSessionEndTime(endTime);
      logger.info(`Orchestrator: session end time set to ${endTime}`);
    }
  }

  // Kick off async cache build (non-blocking — P1 triggers still work during build)
  if (config.campaignWikiCard && !activationBuildInProgress) {
    activationBuildInProgress = true;
    buildActivationCaches(config.campaignWikiCard).catch(err => {
      logger.error('Orchestrator: activation cache build failed:', err);
    }).finally(() => {
      activationBuildInProgress = false;
    });
  }
}

/**
 * Build NPC pre-cache and scene index from the episode plan.
 * Called asynchronously on ACTIVE transition.
 */
async function buildActivationCaches(episodePlanCard: string): Promise<void> {
  logger.info('Orchestrator: building NPC cache and scene index...');

  pacing.setNpcCacheStatus('building');
  pacing.setSceneIndexStatus('building');

  // Build both in parallel
  const [npcResult, sceneResult] = await Promise.allSettled([
    new NpcCacheBuilder(mcp, config.npcCacheMaxBriefWords).build(episodePlanCard),
    new SceneIndexBuilder(mcp, config.autoActiveMinTermLength).build(episodePlanCard),
  ]);

  // Apply NPC cache
  if (npcResult.status === 'fulfilled') {
    npcCache = npcResult.value;
    pacing.setNpcCacheStatus('ready');
    pacing.markNpcCacheBuilt();
    if (triggers) {
      triggers.setNpcCache(npcCache);
      // Backfill: scan recent transcript for NPC mentions that arrived
      // during the async cache build window.
      const recentSegments = transcriptCache.map(s => ({
        text: s.text,
        timestamp: s.timestamp,
      }));
      triggers.backfillNpcMentions(recentSegments);
    }
    if (engine) engine.setNpcCache(npcCache);
    logger.info(`Orchestrator: NPC cache ready (${npcCache.length} entries)`);
  } else {
    pacing.setNpcCacheStatus('error');
    logger.error('Orchestrator: NPC cache build failed:', npcResult.reason);
  }

  // Apply scene index
  if (sceneResult.status === 'fulfilled') {
    sceneIndex = sceneResult.value;
    pacing.setSceneIndexStatus('ready');
    pacing.markSceneIndexBuilt();
    if (triggers) triggers.setSceneIndex(sceneIndex);
    if (engine) engine.setSceneIndex(sceneIndex);
    logger.info(`Orchestrator: scene index ready (${sceneIndex.length} entries)`);
  } else {
    pacing.setSceneIndexStatus('error');
    logger.error('Orchestrator: scene index build failed:', sceneResult.reason);
  }
}

/**
 * Parse a session end time string into ISO 8601.
 * Accepts ISO 8601, "HH:MM", or "H:MM" (interpreted as today or tomorrow).
 */
function parseSessionEndTime(raw: string): string | null {
  // Try ISO 8601 first
  const isoDate = new Date(raw);
  if (!isNaN(isoDate.getTime()) && raw.includes('-')) {
    return isoDate.toISOString();
  }

  // Try HH:MM format
  const timeMatch = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const now = new Date();
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    // If the target time is in the past, assume tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.toISOString();
  }

  logger.warn(`Orchestrator: could not parse SESSION_END_TIME "${raw}"`);
  return null;
}

// ── Transcript polling ─────────────────────────────────────────────────────

async function pollTranscript(): Promise<void> {
  if (!mcp.isConnected('discord')) return;
  if (transcriptPollInFlight) return;
  transcriptPollInFlight = true;

  try {
    // Read active session
    let sessionId: string | null = null;
    try {
      const sessionRaw = await mcp.readResource('discord', 'session://active');
      if (sessionRaw) {
        const session = JSON.parse(sessionRaw);
        if (!session.active || !session.sessions?.length) {
          if (transcriptCache.length > 0) {
            logger.info('Transcript poll: no active session — clearing cache');
            transcriptCache.length = 0;
            lastTranscriptRowId = 0;
            lastSessionId = null;
          }
          return;
        }

        const sessions = session.sessions as Array<{ id: string; guildId?: string }>;
        const targetGuild = config.targetGuildId;
        if (targetGuild) {
          const match = sessions.find(s => s.guildId === targetGuild);
          sessionId = match?.id ?? null;
        } else {
          if (sessions.length > 1) {
            logger.warn(`Transcript poll: ${sessions.length} active sessions — set TARGET_GUILD_ID`);
          }
          sessionId = sessions[0].id ?? null;
        }
      }
    } catch {
      return;
    }

    if (!sessionId) {
      if (lastSessionId !== null && transcriptCache.length > 0) {
        logger.info('Transcript poll: no matching session — clearing cache');
        transcriptCache.length = 0;
        lastTranscriptRowId = 0;
        lastSessionId = null;
      }
      return;
    }

    // Reset on session change — skip trigger feeding on first poll to avoid replaying history
    if (sessionId !== lastSessionId) {
      logger.info(`Transcript poll: session changed (${lastSessionId} → ${sessionId})`);
      lastTranscriptRowId = 0;
      transcriptCache.length = 0;
      lastSessionId = sessionId;
      sessionJustChanged = true;
    }

    const raw = await mcp.readResource('discord', `session://${sessionId}/transcript`);
    if (!raw) return;

    const rawSegments = JSON.parse(raw) as Array<{
      id: number;
      transcript: string;
      segmentStart: string;
      userId?: string;
      displayName?: string;
      speakerLabel?: string;
      isFinal?: boolean;
    }>;
    if (rawSegments.length === 0) return;

    // Client-side incremental: new vs updated
    const newSegments: typeof rawSegments = [];
    const updatedSegments: typeof rawSegments = [];
    for (const seg of rawSegments) {
      if (seg.id > lastTranscriptRowId) {
        newSegments.push(seg);
      } else {
        const cached = transcriptCache.find(c => c.rowId === seg.id);
        if (cached && cached.text !== seg.transcript) {
          updatedSegments.push(seg);
        }
      }
    }

    // Apply in-place updates and re-feed newly-finalized segments to triggers
    const newlyFinalized: typeof rawSegments = [];
    for (const updated of updatedSegments) {
      const idx = transcriptCache.findIndex(c => c.rowId === updated.id);
      if (idx >= 0) {
        transcriptCache[idx].text = updated.transcript;
        if (updated.displayName) {
          transcriptCache[idx].displayName = updated.displayName;
        }
        if (updated.isFinal) {
          newlyFinalized.push(updated);
        }
      }
    }
    if (triggers && newlyFinalized.length > 0) {
      const forTrigger = newlyFinalized.map(s => ({
        text: s.transcript,
        userId: s.userId,
        displayName: s.displayName,
        speakerLabel: s.speakerLabel,
        timestamp: s.segmentStart,
      }));
      triggers.onTranscriptUpdate(forTrigger);
    }

    // Update cursor
    if (newSegments.length > 0) {
      const maxId = Math.max(...newSegments.map(s => s.id));
      if (maxId > lastTranscriptRowId) {
        lastTranscriptRowId = maxId;
      }
    }

    // Cache new segments
    const mapped: CachedSegment[] = newSegments.map(s => ({
      rowId: s.id,
      text: s.transcript,
      userId: s.userId,
      displayName: s.displayName,
      speakerLabel: s.speakerLabel,
      timestamp: s.segmentStart,
    }));

    if (mapped.length > 0) {
      transcriptCache.push(...mapped);
      if (transcriptCache.length > TRANSCRIPT_CACHE_SIZE) {
        transcriptCache.splice(0, transcriptCache.length - TRANSCRIPT_CACHE_SIZE);
      }

      if (sessionJustChanged) {
        sessionJustChanged = false;
        logger.info(`Transcript poll: seeded ${mapped.length} historical segments (triggers skipped)`);
      } else {
        const finalOnly = config.finalSegmentsOnly;
        const toDetect = finalOnly
          ? newSegments.filter(s => s.isFinal)
          : newSegments;

        if (triggers && toDetect.length > 0) {
          const forTrigger = toDetect.map(s => ({
            text: s.transcript,
            userId: s.userId,
            displayName: s.displayName,
            speakerLabel: s.speakerLabel,
            timestamp: s.segmentStart,
          }));
          triggers.onTranscriptUpdate(forTrigger);
        }
      }
    }
    // Text events polling (image queue /yes /no)
    if (lastSessionId) {
      try {
        const textRaw = await mcp.readResource('discord', `session://${lastSessionId}/text-events`);
        if (textRaw) {
          const textEvents = JSON.parse(textRaw) as Array<{
            id?: number;
            content?: string;
            eventType?: string;
          }>;
          for (const evt of textEvents) {
            const evtId = evt.id ?? 0;
            if (evtId <= lastTextEventId) continue;
            lastTextEventId = evtId;

            if (evt.eventType !== 'create') continue;
            const content = evt.content?.trim().toLowerCase();
            if (content === '/yes' && imageQueue.hasPending()) {
              const suggestion = imageQueue.confirm();
              if (suggestion && mcp.isConnected('discord')) {
                try {
                  await mcp.callTool('discord__post_image', {
                    imageUrl: `http://localhost:30000/${suggestion.path}`,
                    caption: suggestion.description,
                    channelId: suggestion.post_to || undefined,
                  });
                  logger.info(`Image posted: ${suggestion.path}`);
                } catch (err) {
                  logger.warn('Failed to post image:', err);
                }
              }
            } else if (content === '/no' && imageQueue.hasPending()) {
              imageQueue.reject();
            }
          }
        }
      } catch {
        // Text events may not be available — non-fatal
      }
    }
  } catch (err) {
    logger.warn('Transcript poll error:', err);
  } finally {
    transcriptPollInFlight = false;
  }
}

// ── Game state polling ─────────────────────────────────────────────────────

async function pollGameState(): Promise<void> {
  if (!mcp.isConnected('foundry') || !triggers) return;
  if (gameStatePollInFlight) return;
  gameStatePollInFlight = true;

  try {
    const raw = await mcp.readResource('foundry', 'game://state');
    if (!raw) return;

    const state = JSON.parse(raw);

    if (state.connectedAt === null) {
      lastSceneId = null;
      lastSeenChatMsgId = null;
      return;
    }

    // Detect scene changes → trigger P2
    const sceneId = state.scene?.id ?? null;
    if (sceneId !== lastSceneId && lastSceneId !== null) {
      triggers.onGameEvent('sceneChange', {
        sceneId,
        sceneName: state.scene?.name ?? '',
      });
    }
    lastSceneId = sceneId;

    // Parse GM commands from new Foundry chat messages (GM-only)
    const chat = state.recentChat as Array<{
      id?: string;
      content?: string;
      speakerAlias?: string;
      isGm?: boolean;
      timestamp?: string;
    }>;
    if (chat.length > 0) {
      if (!lastSeenChatMsgId) {
        lastSeenChatMsgId = chat[chat.length - 1].id ?? null;
      } else {
        const lastIdx = chat.findIndex(m => m.id === lastSeenChatMsgId);
        if (lastIdx >= 0) {
          const newMessages = chat.slice(lastIdx + 1);
          for (const msg of newMessages) {
            if (msg.content && msg.isGm === true) {
              const cmd = parseGmCommand(msg.content, msg.timestamp ?? new Date().toISOString());
              if (cmd) {
                applyGmCommand(cmd);
              }
            }
          }
        }
        lastSeenChatMsgId = chat[chat.length - 1].id ?? lastSeenChatMsgId;
      }
    }
  } catch {
    // Foundry state may not be available
  } finally {
    gameStatePollInFlight = false;
  }
}

// ── GM Command Application ─────────────────────────────────────────────────

function applyGmCommand(cmd: import('./types/index.js').GmCommand): void {
  logger.info(`GM command: ${cmd.raw}`);

  switch (cmd.type) {
    case 'act': {
      const actNum = parseInt(cmd.args[0], 10);
      const planned = parseInt(cmd.args[1], 10) || 0;
      if (Number.isFinite(actNum)) {
        pacing.advanceAct(actNum, planned);
        if (pacing.assistantState === AssistantState.PREGAME) {
          handleActivation('command');
        }
      }
      break;
    }
    case 'scene': {
      let sceneName: string;
      let planned = 0;
      const lastArg = cmd.args[cmd.args.length - 1];
      if (cmd.args.length > 1 && /^\d+$/.test(lastArg)) {
        planned = parseInt(lastArg, 10);
        sceneName = cmd.args.slice(0, -1).join(' ');
      } else {
        sceneName = cmd.args.join(' ');
      }
      pacing.advanceScene(sceneName, planned);
      if (pacing.assistantState === AssistantState.PREGAME) {
        handleActivation('command');
      }
      break;
    }
    case 'spotlight': {
      const player = cmd.args[0];
      const debt = parseInt(cmd.args[1], 10) || 0;
      if (player) pacing.setSpotlight(player, debt);
      break;
    }
    case 'engagement': {
      const player = cmd.args[0];
      const level = cmd.args[1]?.toUpperCase() as 'HIGH' | 'MEDIUM' | 'LOW';
      if (player && level) pacing.setEngagement(player, level);
      break;
    }
    case 'separation': {
      const status = cmd.args[0]?.toUpperCase() as 'NORMAL' | 'SPLIT' | 'CRITICAL';
      if (status) pacing.setSeparation(status);
      break;
    }
    case 'climax': {
      const proximity = cmd.args[0]?.toUpperCase() as 'NORMAL' | 'APPROACHING' | 'ESCALATING' | 'CLIMAX';
      if (proximity) pacing.setClimaxProximity(proximity);
      break;
    }
    case 'seed': {
      const seedName = cmd.args.join(' ');
      if (seedName) pacing.addSeed(seedName, pacing.state.current_scene);
      break;
    }
    case 'sleep':
      pacing.transitionTo(AssistantState.SLEEP);
      logger.info('GM command: ACTIVE → SLEEP');
      break;
    case 'wake':
      handleActivation('command');
      logger.info('GM command: → ACTIVE');
      break;

    // v3 commands
    case 'endtime': {
      const timeStr = cmd.args.join(' ');
      if (timeStr) {
        const endTime = parseSessionEndTime(timeStr);
        if (endTime) {
          pacing.setSessionEndTime(endTime);
          logger.info(`GM command: session end time set to ${endTime}`);
        }
      }
      break;
    }
    case 'npc': {
      const subcommand = cmd.args[0]?.toLowerCase();
      if (subcommand === 'refresh' && config.campaignWikiCard) {
        if (activationBuildInProgress) {
          logger.warn('GM command: NPC cache rebuild already in progress, skipping');
        } else {
          logger.info('GM command: forcing NPC cache rebuild');
          activationBuildInProgress = true;
          buildActivationCaches(config.campaignWikiCard).catch(err => {
            logger.error('GM command: NPC cache rebuild failed:', err);
          }).finally(() => {
            activationBuildInProgress = false;
          });
        }
      } else if (subcommand === 'serve') {
        const npcName = cmd.args.slice(1).join(' ').toLowerCase();
        const npc = npcCache.find(n => n.key === npcName || n.aliases.includes(npcName));
        if (npc) {
          npc.served = false; // Reset served flag so trigger detector will serve it
          logger.info(`GM command: marking ${npc.display_name} for re-serve`);
        } else {
          logger.warn(`GM command: NPC "${npcName}" not found in cache`);
        }
      }
      break;
    }
  }
}

// ── Startup ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('Magi GM Assistant v3 starting...');
  logger.info(`  Model: ${config.anthropicModel}`);
  logger.info(`  Discord MCP: ${config.discordMcpUrl}`);
  logger.info(`  Foundry MCP: ${config.foundryMcpUrl}`);
  logger.info(`  Wiki MCP: ${config.wikiMcpUrl || '(NOT SET — REQUIRED)'}`);

  // ── Step 1: Validate wiki URL ──────────────────────────────────────────
  if (!config.wikiMcpUrl) {
    throw new Error('WIKI_MCP_URL is required. Cannot start without wiki access.');
  }

  // ── Step 2+3: Connect and health-check all MCP servers (with retry) ──
  const STARTUP_RETRIES = 3;
  const STARTUP_BACKOFF_BASE_MS = 2000;
  let wikiHealthy = false;

  for (let attempt = 1; attempt <= STARTUP_RETRIES; attempt++) {
    try {
      if (!mcp.isConnected('wiki')) {
        await mcp.connect();
        const tools = mcp.getAllTools();
        logger.info(`MCP aggregator: ${tools.length} total tools available`);
      }

      const healthResults = await Promise.all([
        mcp.healthCheck('discord'),
        mcp.healthCheck('foundry'),
        mcp.healthCheck('wiki'),
      ]);
      const serverNames = ['discord', 'foundry', 'wiki'];
      for (let i = 0; i < serverNames.length; i++) {
        logger.info(`  ${serverNames[i]} health: ${healthResults[i] ? 'OK' : 'FAIL'}`);
      }

      if (healthResults[2]) {
        wikiHealthy = true;
        break;
      }
    } catch (err) {
      logger.warn(`MCP startup failed (attempt ${attempt}/${STARTUP_RETRIES}):`, err);
    }

    if (attempt < STARTUP_RETRIES) {
      const delayMs = STARTUP_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      logger.warn(`Retrying MCP startup in ${delayMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  if (!wikiHealthy) {
    throw new Error(`Wiki MCP startup failed after ${STARTUP_RETRIES} attempts — cannot start without wiki access.`);
  }

  // ── Step 3b: Validate episode plan wiki card ──────────────────────────
  if (config.campaignWikiCard) {
    try {
      const planRaw = await mcp.readResource('wiki', `card://${config.campaignWikiCard}`, 10_000);
      if (planRaw && planRaw.length > 0) {
        logger.info(`  Episode plan loaded from wiki card: "${config.campaignWikiCard}" (${planRaw.length} chars)`);
      } else {
        logger.warn(`  Episode plan wiki card "${config.campaignWikiCard}" exists but is empty — assistant will have no scene knowledge.`);
      }
    } catch {
      logger.error(`  Failed to load episode plan from wiki card "${config.campaignWikiCard}" — check card name spelling. Assistant will run without scene knowledge.`);
    }
  } else {
    logger.warn('  CAMPAIGN_WIKI_CARD not set — assistant will run without episode plan knowledge.');
  }

  // ── Step 3c: v3 — Load fuzzy match table ─────────────────────────────
  const fuzzyTable = loadFuzzyMatchTable(config.sttFuzzyMatchPath);

  // ── Step 3d: v3 — Log configuration warnings ────────────────────────
  if (!config.gmIdentifier) {
    logger.warn('  GM_IDENTIFIER not set — silence detection and hesitation detection will track all speakers.');
  }
  if (!config.sessionEndTime) {
    logger.warn('  SESSION_END_TIME not set — pacing gates (convergence/denouement) are disabled. Set via /endtime HH:MM during session.');
  }
  if (config.autoActiveEnabled && Object.keys(fuzzyTable).length === 0) {
    logger.warn('  Auto-ACTIVE enabled but fuzzy match table is empty — transcript-based activation may not work. Check STT_FUZZY_MATCH_PATH.');
  }

  // ── Step 4: Initialize state ──────────────────────────────────────────
  pacing.startSession();
  memory.clear();
  logger.info(`  State: ${pacing.assistantState} | Memory cleared | Advice interval: ${config.minAdviceIntervalSeconds}s`);

  // ── Step 5: Create components ─────────────────────────────────────────
  engine = new ReasoningEngine(mcp, pacing, memory, () => [...transcriptCache]);
  delivery = new AdviceDelivery(mcp);

  triggers = new TriggerDetector(pacing, fuzzyTable);

  // v3: Listen for activation events from trigger detector
  triggers.on('activated', (source: ActivationSource) => {
    handleActivation(source);
  });

  triggers.on('trigger', async (batch) => {
    if (!engine || !delivery) return;

    const envelope = await engine.process(batch);
    if (envelope) {
      if (envelope.image) {
        imageQueue.setPending(envelope.image);
      }
      await delivery.deliver(envelope);
    }
  });

  // Deliver advice from queued batches
  engine.on('advice', async (envelope) => {
    if (delivery) {
      if (envelope.image) {
        imageQueue.setPending(envelope.image);
      }
      await delivery.deliver(envelope);
    }
  });

  triggers.start();

  // ── Step 6: Start polling loops ───────────────────────────────────────

  // Transcript: 10s
  transcriptPollTimer = setInterval(() => {
    pollTranscript().catch(err => logger.debug('Transcript poll error:', err));
  }, 10_000);

  // Game state: 10s
  gameStatePollTimer = setInterval(() => {
    pollGameState().catch(err => logger.debug('Game state poll error:', err));
  }, 10_000);

  // Pacing timer update: every 30s
  pacingUpdateTimer = setInterval(() => {
    pacing.updateElapsed();
    if (triggers) {
      triggers.checkPacingOverrun(config.sceneOverrunThresholdMinutes);
    }
  }, 30_000);

  logger.info('GM Assistant v3 ready — monitoring for triggers (PREGAME)');
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
