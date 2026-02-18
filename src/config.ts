import { config as dotenvConfig } from 'dotenv';
import { registerSecret } from './logger.js';

dotenvConfig();

export interface GmConfig {
  anthropicApiKey: string;
  anthropicModel: string;

  // MCP server URLs
  discordMcpUrl: string;
  foundryMcpUrl: string;
  wikiMcpUrl: string;   // REQUIRED in v2

  // MCP auth tokens
  discordMcpToken: string;
  foundryMcpToken: string;
  wikiMcpToken: string;

  // Output
  discordAdviceWebhookUrl: string;

  // Timing / triggers (v2)
  minAdviceIntervalSeconds: number;   // 180 — P1 exempt
  eventBatchWindowSeconds: number;    // 30 — P1 flushes immediately
  sceneOverrunThresholdMinutes: number; // 3
  activeSilenceSeconds: number;       // 90
  sleepSilenceMinutes: number;        // 15
  transcriptWindowMinutes: number;    // 20
  finalSegmentsOnly: boolean;         // true

  // Context / memory
  maxContextTokens: number;           // 20_000
  adviceMaxTokens: number;            // 2048
  adviceMemorySize: number;           // 5

  // Prompts & campaign
  systemPromptPath: string;
  campaignWikiCard: string;

  /** Discord username → Foundry character name mappings (JSON object or empty string). */
  userMappings: Record<string, string>;
  /** Target Discord guild ID — selects which session to track when multiple are active. */
  targetGuildId: string;
  /**
   * GM identifier for silence detection (P4 tracks GM speech only).
   * Matched against both userId and displayName, case-insensitive.
   * For Group 1 (Discord): use the GM's Discord user ID.
   * For Group 2 (diarization): use the speaker label assigned by diarization (e.g. "Speaker 1", "Lake").
   * If empty, falls back to tracking all speech.
   */
  gmIdentifier: string;
}

function parseUserMappings(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch { /* ignore parse errors */ }
  return {};
}

function parseInt10(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

let _config: GmConfig | null = null;

export function getConfig(): GmConfig {
  if (_config) return _config;

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? '';
  const discordMcpToken = process.env.DISCORD_MCP_TOKEN ?? '';
  const foundryMcpToken = process.env.FOUNDRY_MCP_TOKEN ?? '';
  const wikiMcpToken = process.env.WIKI_MCP_TOKEN ?? '';

  // Register secrets for log redaction
  if (anthropicApiKey) registerSecret(anthropicApiKey);
  if (discordMcpToken) registerSecret(discordMcpToken);
  if (foundryMcpToken) registerSecret(foundryMcpToken);
  if (wikiMcpToken) registerSecret(wikiMcpToken);

  // v2: warn if v1 heartbeat env var is still set
  if (process.env.HEARTBEAT_INTERVAL_MINUTES) {
    console.warn(
      '[config] HEARTBEAT_INTERVAL_MINUTES is deprecated in v2 and will be ignored. ' +
      'The heartbeat system has been replaced by event-driven triggers (P1-P4).'
    );
  }

  const wikiMcpUrl = process.env.WIKI_MCP_URL ?? '';
  if (!wikiMcpUrl) {
    console.error(
      '[config] WIKI_MCP_URL is required in v2. The wiki MCP server is a hard dependency.'
    );
  }

  _config = {
    anthropicApiKey,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250929',
    discordMcpUrl: process.env.DISCORD_MCP_URL ?? 'http://127.0.0.1:3001',
    foundryMcpUrl: process.env.FOUNDRY_MCP_URL ?? 'http://127.0.0.1:3002',
    wikiMcpUrl,
    discordMcpToken,
    foundryMcpToken,
    wikiMcpToken,
    discordAdviceWebhookUrl: process.env.DISCORD_ADVICE_WEBHOOK_URL ?? '',

    // Timing / triggers (v2 defaults from Configuration card)
    minAdviceIntervalSeconds: parseInt10(process.env.MIN_ADVICE_INTERVAL_SECONDS, 180),
    eventBatchWindowSeconds: parseInt10(process.env.EVENT_BATCH_WINDOW_SECONDS, 30),
    sceneOverrunThresholdMinutes: parseInt10(process.env.SCENE_OVERRUN_THRESHOLD_MINUTES, 3),
    activeSilenceSeconds: parseInt10(process.env.ACTIVE_SILENCE_SECONDS, 90),
    sleepSilenceMinutes: parseInt10(process.env.SLEEP_SILENCE_MINUTES, 15),
    transcriptWindowMinutes: parseInt10(process.env.TRANSCRIPT_WINDOW_MINUTES, 20),
    finalSegmentsOnly: (process.env.FINAL_SEGMENTS_ONLY ?? 'true').toLowerCase() !== 'false',

    // Context / memory (v2 defaults)
    maxContextTokens: parseInt10(process.env.MAX_CONTEXT_TOKENS, 15_000),
    adviceMaxTokens: parseInt10(process.env.ADVICE_MAX_TOKENS, 2048),
    adviceMemorySize: parseInt10(process.env.ADVICE_MEMORY_SIZE, 5),

    systemPromptPath: process.env.SYSTEM_PROMPT_PATH ?? './prompts/system.md',
    campaignWikiCard: process.env.CAMPAIGN_WIKI_CARD ?? '',
    userMappings: parseUserMappings(process.env.USER_MAPPINGS ?? ''),
    targetGuildId: process.env.TARGET_GUILD_ID ?? '',
    gmIdentifier: process.env.GM_IDENTIFIER ?? '',
  };

  return _config;
}

/** Reset cached config (for testing). */
export function resetConfig(): void {
  _config = null;
}
