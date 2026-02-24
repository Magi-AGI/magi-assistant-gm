import { config as dotenvConfig } from 'dotenv';
import { registerSecret } from './logger.js';

dotenvConfig();

export interface GmConfig {
  anthropicApiKey: string;
  anthropicModel: string;

  // MCP server URLs
  discordMcpUrl: string;
  foundryMcpUrl: string;
  wikiMcpUrl: string; // Required hard dependency

  // MCP auth tokens
  discordMcpToken: string;
  foundryMcpToken: string;
  wikiMcpToken: string;

  // Output
  discordAdviceWebhookUrl: string;

  // Timing / triggers
  minAdviceIntervalSeconds: number;
  eventBatchWindowSeconds: number;
  sceneOverrunThresholdMinutes: number;
  activeSilenceSeconds: number;
  sleepSilenceMinutes: number;
  transcriptWindowMinutes: number;
  finalSegmentsOnly: boolean;

  // v3 timing / triggers
  sessionEndTime: string;
  convergenceGateMinutes: number;
  denouementGateMinutes: number;
  autoActiveEnabled: boolean;
  autoActiveWindowMinutes: number;
  autoActiveThreshold: number;
  autoActiveMinTermLength: number;
  hesitationSilenceSeconds: number;
  hesitationKeywords: string[];

  // Context / memory
  maxContextTokens: number;
  adviceMaxTokens: number;
  adviceMemorySize: number;
  npcCacheMaxBriefWords: number;

  // Paths / data files
  systemPromptPath: string;
  campaignWikiCard: string;
  sttFuzzyMatchPath: string;

  // State persistence (opt-in)
  statePersistenceEnabled: boolean;
  statePersistencePath: string;
  statePersistenceMaxAgeMinutes: number;

  /** Discord username -> Foundry character name mappings (JSON object or empty string). */
  userMappings: Record<string, string>;
  /** Target Discord guild ID - selects which session to track when multiple are active. */
  targetGuildId: string;
  /**
   * GM identifier for silence/hesitation detection.
   * Matched against userId, displayName, and speakerLabel (case-insensitive).
   * If empty, falls back to tracking all speech.
   */
  gmIdentifier: string;
}

const DEFAULT_HESITATION_KEYWORDS = [
  "what's the",
  'uh',
  'um',
  'his name',
  'her name',
  'their name',
  'the thing',
  'remind me',
  'i forget',
];

function parseUserMappings(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Ignore parse errors and fall back to empty mapping.
  }
  return {};
}

function parseInt10(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseStringArray(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Ignore parse errors and use fallback.
  }
  return fallback;
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

  const wikiMcpUrl = process.env.WIKI_MCP_URL ?? '';
  if (!wikiMcpUrl) {
    console.error('[config] WIKI_MCP_URL is required. The wiki MCP server is a hard dependency.');
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

    // Timing / triggers
    minAdviceIntervalSeconds: parseInt10(process.env.MIN_ADVICE_INTERVAL_SECONDS, 180),
    eventBatchWindowSeconds: parseInt10(process.env.EVENT_BATCH_WINDOW_SECONDS, 30),
    sceneOverrunThresholdMinutes: parseInt10(process.env.SCENE_OVERRUN_THRESHOLD_MINUTES, 3),
    activeSilenceSeconds: parseInt10(process.env.ACTIVE_SILENCE_SECONDS, 90),
    sleepSilenceMinutes: parseInt10(process.env.SLEEP_SILENCE_MINUTES, 15),
    transcriptWindowMinutes: parseInt10(process.env.TRANSCRIPT_WINDOW_MINUTES, 20),
    finalSegmentsOnly: parseBoolean(process.env.FINAL_SEGMENTS_ONLY, true),

    // v3 timing / triggers
    sessionEndTime: process.env.SESSION_END_TIME ?? '',
    convergenceGateMinutes: parseInt10(process.env.CONVERGENCE_GATE_MINUTES, 45),
    denouementGateMinutes: parseInt10(process.env.DENOUEMENT_GATE_MINUTES, 20),
    autoActiveEnabled: parseBoolean(process.env.AUTO_ACTIVE_ENABLED, true),
    autoActiveWindowMinutes: parseInt10(process.env.AUTO_ACTIVE_WINDOW_MINUTES, 5),
    autoActiveThreshold: parseInt10(process.env.AUTO_ACTIVE_THRESHOLD, 3),
    autoActiveMinTermLength: parseInt10(process.env.AUTO_ACTIVE_MIN_TERM_LENGTH, 4),
    hesitationSilenceSeconds: parseInt10(process.env.HESITATION_SILENCE_SECONDS, 5),
    hesitationKeywords: parseStringArray(process.env.HESITATION_KEYWORDS, DEFAULT_HESITATION_KEYWORDS),

    // Context / memory
    maxContextTokens: parseInt10(process.env.MAX_CONTEXT_TOKENS, 20_000),
    adviceMaxTokens: parseInt10(process.env.ADVICE_MAX_TOKENS, 2048),
    adviceMemorySize: parseInt10(process.env.ADVICE_MEMORY_SIZE, 5),
    npcCacheMaxBriefWords: parseInt10(process.env.NPC_CACHE_MAX_BRIEF_WORDS, 60),

    // Paths / data files
    systemPromptPath: process.env.SYSTEM_PROMPT_PATH ?? './prompts/system.md',
    campaignWikiCard: process.env.CAMPAIGN_WIKI_CARD ?? '',
    sttFuzzyMatchPath: process.env.STT_FUZZY_MATCH_PATH ?? './config/fuzzy-match.json',

    // State persistence (opt-in)
    statePersistenceEnabled: parseBoolean(process.env.STATE_PERSISTENCE_ENABLED, false),
    statePersistencePath: process.env.STATE_PERSISTENCE_PATH ?? './.runtime/gm-state.json',
    statePersistenceMaxAgeMinutes: parseInt10(process.env.STATE_PERSISTENCE_MAX_AGE_MINUTES, 360),

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
