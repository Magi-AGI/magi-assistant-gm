import { config as dotenvConfig } from 'dotenv';
import { registerSecret } from './logger.js';

dotenvConfig();

export interface GmConfig {
  anthropicApiKey: string;
  anthropicModel: string;
  discordMcpUrl: string;
  foundryMcpUrl: string;
  wikiMcpUrl: string;
  mcpAuthToken: string;
  discordAdviceWebhookUrl: string;
  heartbeatIntervalMinutes: number;
  eventBatchWindowSeconds: number;
  maxContextTokens: number;
  adviceMaxTokens: number;
  systemPromptPath: string;
  campaignWikiCard: string;
  /** Discord username → Foundry character name mappings (JSON object or empty string). */
  userMappings: Record<string, string>;
  /** Target Discord guild ID — selects which session to track when multiple are active. */
  targetGuildId: string;
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

let _config: GmConfig | null = null;

export function getConfig(): GmConfig {
  if (_config) return _config;

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? '';
  const mcpAuthToken = process.env.MCP_AUTH_TOKEN ?? '';

  // Register secrets for log redaction
  if (anthropicApiKey) registerSecret(anthropicApiKey);
  if (mcpAuthToken) registerSecret(mcpAuthToken);

  _config = {
    anthropicApiKey,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250929',
    discordMcpUrl: process.env.DISCORD_MCP_URL ?? 'http://127.0.0.1:3001',
    foundryMcpUrl: process.env.FOUNDRY_MCP_URL ?? 'http://127.0.0.1:3002',
    wikiMcpUrl: process.env.WIKI_MCP_URL ?? '',
    mcpAuthToken,
    discordAdviceWebhookUrl: process.env.DISCORD_ADVICE_WEBHOOK_URL ?? '',
    heartbeatIntervalMinutes: parseInt(process.env.HEARTBEAT_INTERVAL_MINUTES ?? '5', 10) || 5,
    eventBatchWindowSeconds: parseInt(process.env.EVENT_BATCH_WINDOW_SECONDS ?? '30', 10) || 30,
    maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS ?? '100000', 10) || 100_000,
    adviceMaxTokens: parseInt(process.env.ADVICE_MAX_TOKENS ?? '2048', 10) || 2048,
    systemPromptPath: process.env.SYSTEM_PROMPT_PATH ?? './prompts/system.md',
    campaignWikiCard: process.env.CAMPAIGN_WIKI_CARD ?? '',
    userMappings: parseUserMappings(process.env.USER_MAPPINGS ?? ''),
    targetGuildId: process.env.TARGET_GUILD_ID ?? '',
  };

  return _config;
}
