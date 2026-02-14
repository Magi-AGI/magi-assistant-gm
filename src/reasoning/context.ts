/**
 * Context assembler — fetches data from all MCP servers and builds
 * the system prompt + context for Claude reasoning.
 */

import * as fs from 'fs';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { McpAggregator } from '../mcp/client.js';
import type { TriggerBatch, AssembledContext } from '../types/index.js';

// Rough token estimation: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ContextAssembler {
  private systemPromptTemplate: string = '';

  constructor(private mcp: McpAggregator) {}

  /** Load the system prompt template from disk. */
  loadTemplate(): void {
    const config = getConfig();
    try {
      this.systemPromptTemplate = fs.readFileSync(config.systemPromptPath, 'utf-8');
      logger.info(`ContextAssembler: loaded system prompt from ${config.systemPromptPath}`);
    } catch (err) {
      logger.warn('ContextAssembler: failed to load system prompt template, using default:', err);
      this.systemPromptTemplate = DEFAULT_SYSTEM_PROMPT;
    }
  }

  /**
   * Assemble full context for a reasoning invocation.
   * @param transcriptSegments Pre-fetched transcript segments from the local cache
   *   (index.ts manages incremental polling and caching).
   */
  async assemble(
    batch: TriggerBatch,
    transcriptSegments: Array<{ text: string; userId?: string; displayName?: string; timestamp: string }>,
  ): Promise<AssembledContext> {
    const config = getConfig();
    const maxTokens = config.maxContextTokens;

    // Fetch game state and campaign context from MCP in parallel
    // (transcript is provided by caller — no MCP fetch needed)
    const [gameStateRaw, campaignRaw] = await Promise.allSettled([
      this.mcp.readResource('foundry', 'game://state'),
      config.campaignWikiCard && this.mcp.isConnected('wiki')
        ? this.mcp.readResource('wiki', `card://${config.campaignWikiCard}`)
        : Promise.resolve(''),
    ]);

    let gameState = gameStateRaw.status === 'fulfilled' ? gameStateRaw.value : '{}';

    // Check for stale state: if Foundry module is disconnected, warn Claude
    try {
      const parsed = JSON.parse(gameState);
      if (parsed.connectedAt === null) {
        gameState = '{"warning": "Foundry module is disconnected. Game state below may be stale.", ' +
          gameState.slice(1);
        logger.info('ContextAssembler: Foundry disconnected — marking game state as stale');
      }
    } catch { /* keep raw gameState on parse failure */ }
    const campaign = campaignRaw.status === 'fulfilled' ? campaignRaw.value : '';

    // Build trigger summary
    const triggerSummary = this.summarizeTriggers(batch);

    // Build user mappings section
    const mappings = config.userMappings;
    const mappingsText = Object.keys(mappings).length > 0
      ? Object.entries(mappings).map(([discord, character]) => `- ${discord} → ${character}`).join('\n')
      : 'No mappings configured. Discord usernames may differ from Foundry character names.';

    // System prompt is STATIC — no dynamic player/game content to prevent prompt injection.
    // Dynamic content (game state, campaign, mappings) goes into user messages.
    const systemPrompt = this.systemPromptTemplate;

    // Strip HTML tags from game state to prevent markup injection
    const sanitizedGameState = this.stripHtml(gameState);
    const sanitizedCampaign = this.stripHtml(campaign || 'No campaign context available.');

    // Token budget management: count all dynamic context
    const dynamicContextTokens = estimateTokens(sanitizedGameState) +
      estimateTokens(sanitizedCampaign) + estimateTokens(mappingsText);
    const fixedTokens = estimateTokens(systemPrompt) + estimateTokens(triggerSummary) + dynamicContextTokens;
    const availableForTranscript = maxTokens - fixedTokens - 2000; // Reserve 2000 for response

    // Build transcript text from segments, dropping oldest if over budget
    const recentTranscript = this.buildTranscriptText(transcriptSegments, availableForTranscript);

    // Compose the dynamic context block (injected as user message, not system prompt)
    const gameContext = `## Current Game State\n${sanitizedGameState}\n\n## Campaign Knowledge\n${sanitizedCampaign}\n\n## Player Identity Mappings\n${mappingsText}`;

    const tools = this.mcp.getAllTools();

    const estimatedTokens = estimateTokens(systemPrompt) +
      estimateTokens(triggerSummary) +
      estimateTokens(recentTranscript) +
      estimateTokens(gameContext);

    return {
      systemPrompt,
      triggerSummary,
      recentTranscript,
      gameState: gameContext,
      tools,
      estimatedTokens,
    };
  }

  /**
   * Build transcript text from segments, truncating by dropping oldest
   * complete segments (never cutting mid-segment) to fit token budget.
   */
  private buildTranscriptText(
    segments: Array<{ text: string; userId?: string; displayName?: string; timestamp: string }>,
    maxTokens: number,
  ): string {
    if (segments.length === 0) return '';

    // Format each segment as a line
    const lines = segments.map((s) => {
      const speaker = s.displayName ?? s.userId ?? 'Unknown';
      return `[${s.timestamp}] ${speaker}: ${s.text}`;
    });

    // Build from newest, prepending until we hit the budget
    const result: string[] = [];
    let totalTokens = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineTokens = estimateTokens(lines[i]);
      if (totalTokens + lineTokens > maxTokens) {
        result.unshift('...[earlier transcript truncated]');
        break;
      }
      result.unshift(lines[i]);
      totalTokens += lineTokens;
    }

    return result.join('\n');
  }

  /** Strip HTML tags from content to prevent markup injection into model context. */
  private stripHtml(text: string): string {
    return text.replace(/<[^>]*>/g, '');
  }

  private summarizeTriggers(batch: TriggerBatch): string {
    if (batch.events.length === 0) return 'No specific triggers.';

    const parts: string[] = [];
    for (const event of batch.events) {
      switch (event.type) {
        case 'question':
          parts.push(`Player question detected: "${(event.data.transcript as string) ?? ''}"`);
          break;
        case 'game_event':
          parts.push(`Game event: ${event.source} (priority ${event.priority})`);
          break;
        case 'heartbeat':
          parts.push('Periodic check-in (heartbeat)');
          break;
        case 'on_demand':
          parts.push(`GM requested advice: "${(event.data.context as string) ?? ''}"`);
          break;
      }
    }

    return parts.join('\n');
  }
}

const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant helping a Fate Core GM in real-time during a tabletop RPG session.

## Guidelines
- Keep advice concise: 2-3 sentences max
- Reference specific character aspects, skills, and fate points when relevant
- Suggest compelling compels when character aspects create interesting drama
- Use Fate ladder names (Great +4, Good +3, Fair +2, etc.) when discussing skill levels
- If nothing noteworthy is happening, respond with exactly: NO_ADVICE
- Focus on being helpful without being intrusive
`;
