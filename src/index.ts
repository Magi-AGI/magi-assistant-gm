import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { getConfig } from './config.js';
import { logger } from './logger.js';
import { McpAggregator } from './mcp/client.js';
import { TriggerDetector } from './reasoning/triggers.js';
import { ReasoningEngine } from './reasoning/engine.js';
import { AdviceDelivery } from './output/index.js';

const config = getConfig();

const mcp = new McpAggregator();
let triggers: TriggerDetector | null = null;
let engine: ReasoningEngine | null = null;
let delivery: AdviceDelivery | null = null;
let transcriptPollTimer: ReturnType<typeof setInterval> | null = null;
let gameStatePollTimer: ReturnType<typeof setInterval> | null = null;
let lastTranscriptRowId = 0;
let lastTranscriptPollTime: string | null = null;
let lastSessionId: string | null = null;
let lastCombatRound: number | null = null;
let lastSceneId: string | null = null;
let lastSeenChatMsgId: string | null = null;
let transcriptPollInFlight = false;
let gameStatePollInFlight = false;

// Local transcript cache — ring buffer of recent segments for context assembly.
// Populated incrementally via ?after_id= polling (avoids re-downloading the full transcript).
const TRANSCRIPT_CACHE_SIZE = 500;
interface CachedSegment {
  rowId: number;
  text: string;
  userId?: string;
  displayName?: string;
  timestamp: string;
}
const transcriptCache: CachedSegment[] = [];

// --- Graceful shutdown ---

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal} — starting graceful shutdown...`);

  try {
    if (transcriptPollTimer) {
      clearInterval(transcriptPollTimer);
      transcriptPollTimer = null;
    }
    if (gameStatePollTimer) {
      clearInterval(gameStatePollTimer);
      gameStatePollTimer = null;
    }
    if (triggers) {
      triggers.stop();
    }
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

// --- Transcript polling ---

async function pollTranscript(): Promise<void> {
  if (!mcp.isConnected('discord')) return;
  if (transcriptPollInFlight) return; // Prevent reentrancy
  transcriptPollInFlight = true;

  try {
    // Read active session info to get the real session ID
    // Discord returns { active: bool, sessions: [{ id, guildId, ... }] }
    let sessionId: string | null = null;
    try {
      const sessionRaw = await mcp.readResource('discord', 'session://active');
      if (sessionRaw) {
        const session = JSON.parse(sessionRaw);
        if (!session.active || !session.sessions?.length) {
          // No active session — clear stale transcript cache so heartbeat/game-event
          // advice doesn't reference a previous session's conversation
          if (transcriptCache.length > 0) {
            logger.info('Transcript poll: no active session — clearing transcript cache');
            transcriptCache.length = 0;
            lastTranscriptRowId = 0;
            lastSessionId = null;
          }
          return;
        }

        const sessions = session.sessions as Array<{ id: string; guildId?: string }>;

        // If targetGuildId is configured, find the matching session
        const targetGuild = config.targetGuildId;
        if (targetGuild) {
          const match = sessions.find((s) => s.guildId === targetGuild);
          sessionId = match?.id ?? null;
        } else {
          if (sessions.length > 1) {
            logger.warn(`Transcript poll: ${sessions.length} active sessions but TARGET_GUILD_ID is not set — using first session. Set TARGET_GUILD_ID to target a specific guild.`);
          }
          sessionId = sessions[0].id ?? null;
        }
      }
    } catch {
      return; // Can't determine session — skip this poll
    }

    if (!sessionId) {
      // targetGuildId is set but no matching session — clear stale cache
      if (lastSessionId !== null && transcriptCache.length > 0) {
        logger.info('Transcript poll: no matching session for TARGET_GUILD_ID — clearing transcript cache');
        transcriptCache.length = 0;
        lastTranscriptRowId = 0;
        lastTranscriptPollTime = null;
        lastSessionId = null;
      }
      return;
    }

    // Reset cursor and cache on session change
    if (sessionId !== lastSessionId) {
      logger.info(`Transcript poll: session changed (${lastSessionId} → ${sessionId}), resetting cursor`);
      lastTranscriptRowId = 0;
      lastTranscriptPollTime = null;
      transcriptCache.length = 0;
      lastSessionId = sessionId;
    }

    // Fetch all transcript segments (no query params — MCP SDK URI template
    // matching doesn't support query strings). Filter client-side by cursor.
    const uri = `session://${sessionId}/transcript`;

    const raw = await mcp.readResource('discord', uri);
    if (!raw) return;

    // Discord MCP returns segments as { id, transcript, segmentStart, userId, displayName, isFinal, ... }
    const rawSegments = JSON.parse(raw) as Array<{
      id: number;
      transcript: string;
      segmentStart: string;
      userId?: string;
      displayName?: string;
      isFinal?: boolean;
    }>;
    if (rawSegments.length === 0) return;

    // Client-side incremental: separate new vs already-seen segments
    const newSegments: typeof rawSegments = [];
    const updatedSegments: typeof rawSegments = [];
    for (const seg of rawSegments) {
      if (seg.id > lastTranscriptRowId) {
        newSegments.push(seg);
      } else {
        // Check if cached text differs (interim → final update)
        const cached = transcriptCache.find((c) => c.rowId === seg.id);
        if (cached && cached.text !== seg.transcript) {
          updatedSegments.push(seg);
        }
      }
    }

    // Apply in-place updates to cached segments (interim → final corrections, speaker mappings)
    for (const updated of updatedSegments) {
      const idx = transcriptCache.findIndex((c) => c.rowId === updated.id);
      if (idx >= 0) {
        transcriptCache[idx].text = updated.transcript;
        if (updated.displayName) {
          transcriptCache[idx].displayName = updated.displayName;
        }
      }
    }

    // Update cursor to highest new row ID
    if (newSegments.length > 0) {
      const maxId = Math.max(...newSegments.map((s) => s.id));
      if (maxId > lastTranscriptRowId) {
        lastTranscriptRowId = maxId;
      }
    }

    // Map and cache new segments
    const mapped: CachedSegment[] = newSegments.map((s) => ({
      rowId: s.id,
      text: s.transcript,
      userId: s.userId,
      displayName: s.displayName,
      timestamp: s.segmentStart,
    }));

    if (mapped.length > 0) {
      transcriptCache.push(...mapped);
      // Trim cache to ring buffer size
      if (transcriptCache.length > TRANSCRIPT_CACHE_SIZE) {
        transcriptCache.splice(0, transcriptCache.length - TRANSCRIPT_CACHE_SIZE);
      }

      // Feed only FINAL segments to trigger detector for question detection.
      // Interim segments produce noisy partial matches ("generate?", "name?", etc.)
      // that flood the trigger queue with duplicate priority-4 events.
      const finalSegments = newSegments.filter((s) => s.isFinal);
      if (triggers && finalSegments.length > 0) {
        const forTrigger = finalSegments.map((s) => ({
          text: s.transcript,
          userId: s.userId,
          timestamp: s.segmentStart,
        }));
        logger.info(`Transcript poll: ${finalSegments.length} final segments for trigger detection`);
        triggers.onTranscriptUpdate(forTrigger);
      }
    }
  } catch (err) {
    logger.warn('Transcript poll error:', err);
  } finally {
    transcriptPollInFlight = false;
  }
}

// --- Game state polling ---

async function pollGameState(): Promise<void> {
  if (!mcp.isConnected('foundry') || !triggers) return;
  if (gameStatePollInFlight) return; // Prevent reentrancy
  gameStatePollInFlight = true;

  try {
    const raw = await mcp.readResource('foundry', 'game://state');
    if (!raw) return;

    const state = JSON.parse(raw);

    // Skip event processing if Foundry is disconnected — state is stale.
    // Reset cursors so reconnect doesn't produce spurious "changed" events.
    if (state.connectedAt === null) {
      lastCombatRound = null;
      lastSceneId = null;
      lastSeenChatMsgId = null;
      return;
    }

    // Detect combat changes
    if (state.combat) {
      const round = state.combat.round as number;
      if (lastCombatRound === null) {
        // Combat started
        triggers.onGameEvent('combatUpdate', { started: true, round });
        lastCombatRound = round;
      } else if (round !== lastCombatRound) {
        triggers.onGameEvent('combatUpdate', { round, previousRound: lastCombatRound });
        lastCombatRound = round;
      }
    } else if (lastCombatRound !== null) {
      // Combat ended
      triggers.onGameEvent('combatUpdate', { ended: true });
      lastCombatRound = null;
    }

    // Detect scene changes
    const sceneId = state.scene?.id ?? null;
    if (sceneId !== lastSceneId && lastSceneId !== null) {
      triggers.onGameEvent('sceneChange', { sceneId, sceneName: state.scene?.name ?? '' });
    }
    lastSceneId = sceneId;

    // Detect new chat messages with rolls — track by last seen message ID
    // (array length stays at 50 once full, so length-based tracking breaks)
    const chat = state.recentChat as Array<{ id?: string; rolls?: unknown[]; speakerAlias?: string }>;
    if (chat.length > 0) {
      if (!lastSeenChatMsgId) {
        // First poll — just set cursor, don't replay history
        lastSeenChatMsgId = chat[chat.length - 1].id ?? null;
      } else {
        const lastIdx = chat.findIndex((m) => m.id === lastSeenChatMsgId);
        if (lastIdx >= 0) {
          // Found cursor — process messages after it
          const newMessages = chat.slice(lastIdx + 1);
          for (const msg of newMessages) {
            if (msg.rolls && msg.rolls.length > 0) {
              triggers.onGameEvent('chatMessage', { hasRoll: true, speaker: msg.speakerAlias });
            }
          }
        }
        // If not found, cursor scrolled out of the 50-item window.
        // Skip this poll cycle rather than replaying everything as "new".
        // We'll pick up genuinely new messages on the next poll.

        // Advance cursor to latest message
        lastSeenChatMsgId = chat[chat.length - 1].id ?? lastSeenChatMsgId;
      }
    }
  } catch {
    // Foundry state may not be available — that's fine
  } finally {
    gameStatePollInFlight = false;
  }
}

// --- Startup ---

async function main(): Promise<void> {
  logger.info('Magi GM Assistant starting...');
  logger.info(`  Model: ${config.anthropicModel}`);
  logger.info(`  Discord MCP: ${config.discordMcpUrl}`);
  logger.info(`  Foundry MCP: ${config.foundryMcpUrl}`);
  logger.info(`  Wiki MCP: ${config.wikiMcpUrl || '(disabled)'}`);

  // 1. Connect MCP aggregator
  await mcp.connect();

  const tools = mcp.getAllTools();
  logger.info(`MCP aggregator: ${tools.length} total tools available`);

  // 2. Create reasoning engine + advice delivery
  engine = new ReasoningEngine(mcp, () => [...transcriptCache]);
  delivery = new AdviceDelivery(mcp);

  // 3. Create trigger detector, wire trigger → engine → delivery
  triggers = new TriggerDetector();
  triggers.on('trigger', async (batch) => {
    if (!engine || !delivery) return;

    const advice = await engine.process(batch);
    if (advice) {
      await delivery.deliver(advice);
    }
  });

  // Also deliver advice from queued batches (processed async by engine)
  engine.on('advice', async (advice) => {
    if (delivery) {
      await delivery.deliver(advice);
    }
  });

  triggers.start();

  // 4. Poll Discord transcript every 10s
  transcriptPollTimer = setInterval(() => {
    pollTranscript().catch((err) => {
      logger.debug('Transcript poll error:', err);
    });
  }, 10_000);

  // 5. Poll Foundry game state every 10s for combat/scene/roll events
  gameStatePollTimer = setInterval(() => {
    pollGameState().catch((err) => {
      logger.debug('Game state poll error:', err);
    });
  }, 10_000);

  logger.info('GM Assistant ready — monitoring for triggers');
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
