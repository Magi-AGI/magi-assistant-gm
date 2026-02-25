/**
 * v3 Context assembler — configurable token budget with freshness tracking,
 * compressed roster, pacing state, ALREADY ADVISED injection,
 * and trigger-driven scene/NPC card pre-fetch.
 */

import * as fs from 'fs';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { McpAggregator } from '../mcp/client.js';
import type { PacingStateManager } from '../state/pacing.js';
import type { AdviceMemoryBuffer } from '../state/advice-memory.js';
import type { TriggerBatch, AssembledContext, NpcCacheEntry, SceneIndexEntry } from '../types/index.js';

// ── Tools that Claude must NOT call directly ────────────────────────────────
// Image posting requires GM confirmation via /yes — Claude suggests, orchestrator posts.
const BLOCKED_TOOLS = new Set(['discord__post_image']);

// ── Token estimation (~4 chars/token) ──────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Context budget targets ──────────────────────────────────────────────────
//
// Default ceiling: 15,000 tokens (MAX_CONTEXT_TOKENS env var)
//   System prompt:     ~3,000
//   Episode plan:      ~1,500
//   Pacing state:        ~300
//   Character roster:  ~1,500
//   Recent transcript: ~5,000–6,000
//   ALREADY ADVISED:   ~1,500
//   Tool definitions:  ~2,000–4,000  (included in estimate)
//   Response reserve:  ~2,000
//

const BUDGET_EPISODE_PLAN = 1500;
const BUDGET_ROSTER = 1500;
const BUDGET_ALREADY_ADVISED = 1500;
const BUDGET_NPC_CACHE = 500;
const BUDGET_SCENE_CARD = 1500;
const BUDGET_NPC_CARD = 800;
const BUDGET_RESPONSE_RESERVE = 2000;

// ── MCP result extraction ─────────────────────────────────────────────────

/** Extract text content from an MCP callTool result. */
function extractMcpText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    for (const item of r.content) {
      if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text') {
        const text = (item as Record<string, unknown>).text;
        if (typeof text === 'string') return text;
      }
    }
  }
  return null;
}

/** Extract HTML from a wiki get_card result (handles JSON envelope). */
function extractCardHtml(result: unknown): string | null {
  const text = extractMcpText(result);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.text === 'string') {
      return parsed.text;
    }
  } catch { /* not JSON — raw HTML */ }
  return text;
}

export class ContextAssembler {
  private systemPromptTemplate: string = '';
  private npcCache: NpcCacheEntry[] = [];
  private sceneIndex: SceneIndexEntry[] = [];

  constructor(
    private mcp: McpAggregator,
    private pacing: PacingStateManager,
    private memory: AdviceMemoryBuffer,
  ) {}

  setNpcCache(cache: NpcCacheEntry[]): void {
    this.npcCache = cache;
  }

  setSceneIndex(index: SceneIndexEntry[]): void {
    this.sceneIndex = index;
  }

  /**
   * Fetch a wiki card's text content via MCP. Returns stripped HTML or null.
   * Non-throwing: logs and returns null on failure.
   */
  private async fetchWikiCard(cardPath: string): Promise<string | null> {
    try {
      const result = await this.mcp.callTool('wiki__get_card', {
        name: cardPath,
        max_content_length: 8000,
      });
      const html = extractCardHtml(result);
      return html ? this.stripHtml(html) : null;
    } catch (err) {
      logger.warn(`ContextAssembler: failed to fetch wiki card "${cardPath}":`, err);
      return null;
    }
  }

  /**
   * v3: Pre-fetch scene and NPC cards referenced by trigger events.
   * Returns context blocks to inject, saving Claude tool-use iterations.
   */
  private async prefetchTriggerCards(batch: TriggerBatch): Promise<{ sceneCardBlock: string; npcCardBlock: string }> {
    let sceneCardBlock = '';
    let npcCardBlock = '';

    // Collect card paths to pre-fetch
    const sceneEvent = batch.events.find(e => e.type === 'scene_transition_detected');
    const npcEvent = batch.events.find(e => e.type === 'npc_first_appearance');

    const sceneCardPath = sceneEvent?.data.scene_card as string | undefined;
    const npcCardPath = npcEvent?.data.npc_card as string | undefined;

    if (!sceneCardPath && !npcCardPath) return { sceneCardBlock, npcCardBlock };

    // Fetch in parallel
    const [sceneResult, npcResult] = await Promise.allSettled([
      sceneCardPath ? this.fetchWikiCard(sceneCardPath) : Promise.resolve(null),
      npcCardPath ? this.fetchWikiCard(npcCardPath) : Promise.resolve(null),
    ]);

    if (sceneResult.status === 'fulfilled' && sceneResult.value) {
      const title = sceneEvent!.data.scene_title as string;
      sceneCardBlock = this.truncateToTokens(
        `Scene: ${title}\n\n${sceneResult.value}`,
        BUDGET_SCENE_CARD,
      );
      logger.info(`ContextAssembler: pre-fetched scene card "${sceneCardPath}" (~${estimateTokens(sceneCardBlock)} tokens)`);
    }

    if (npcResult.status === 'fulfilled' && npcResult.value) {
      const name = npcEvent!.data.npc_name as string;
      npcCardBlock = this.truncateToTokens(
        `NPC: ${name}\n\n${npcResult.value}`,
        BUDGET_NPC_CARD,
      );
      logger.info(`ContextAssembler: pre-fetched NPC card "${npcCardPath}" (~${estimateTokens(npcCardBlock)} tokens)`);
    }

    return { sceneCardBlock, npcCardBlock };
  }

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
   * Enforces configurable token ceiling (default 15k).
   */
  async assemble(
    batch: TriggerBatch,
    transcriptSegments: Array<{ text: string; userId?: string; displayName?: string; timestamp: string }>,
  ): Promise<AssembledContext> {
    const config = getConfig();
    const maxTokens = config.maxContextTokens;

    // ── Parallel MCP fetches ────────────────────────────────────────────
    const [gameStateRaw, episodePlanRaw] = await Promise.allSettled([
      this.mcp.readResource('foundry', 'game://state'),
      config.campaignWikiCard && this.mcp.isConnected('wiki')
        ? this.mcp.readResource('wiki', `card://${config.campaignWikiCard}`)
        : Promise.resolve(''),
    ]);

    let gameState = gameStateRaw.status === 'fulfilled' ? gameStateRaw.value : '{}';
    const episodePlan = episodePlanRaw.status === 'fulfilled' ? episodePlanRaw.value : '';

    // Check Foundry connectivity
    try {
      const parsed = JSON.parse(gameState);
      if (parsed.connectedAt === null) {
        parsed.warning = 'Foundry module disconnected — state may be stale.';
        gameState = JSON.stringify(parsed);
      }
    } catch { /* keep raw */ }

    // Update freshness timestamps
    if (gameStateRaw.status === 'fulfilled') {
      this.pacing.updateFoundryFreshness(new Date().toISOString());
    }
    if (episodePlanRaw.status === 'fulfilled' && episodePlan) {
      this.pacing.updateWikiFreshness(new Date().toISOString());
    }

    // ── Build components ────────────────────────────────────────────────

    const systemPrompt = this.systemPromptTemplate;
    const triggerSummary = this.summarizeTriggers(batch);
    const pacingBlock = this.buildPacingBlock();
    const rosterBlock = this.buildCompressedRoster(gameState);
    const episodeBlock = this.truncateToTokens(this.stripHtml(episodePlan || 'No episode plan loaded.'), BUDGET_EPISODE_PLAN);
    const npcBlock = this.buildNpcBlock();
    const advisedBlock = this.buildAlreadyAdvisedBlock();
    const freshnessBlock = this.buildFreshnessWarnings();
    const mappingsText = this.buildMappingsText();

    // v3/v4: Pre-fetch scene/NPC cards referenced by trigger events
    const { sceneCardBlock, npcCardBlock } = await this.prefetchTriggerCards(batch);

    // ── Tool definitions (computed early — needed for budget) ──────────

    // Filter out tools that Claude must not call directly (image posting requires GM confirmation)
    const tools = this.mcp.getAllTools().filter(
      t => !BLOCKED_TOOLS.has(t.name)
    );
    // Tool definitions (JSON schemas) consume 2-4k tokens — must be subtracted
    // from transcript budget so the full request stays within maxContextTokens.
    const toolTokens = estimateTokens(JSON.stringify(tools));

    // ── Token accounting ────────────────────────────────────────────────

    const fixedTokens = estimateTokens(systemPrompt) +
      estimateTokens(triggerSummary) +
      estimateTokens(pacingBlock) +
      estimateTokens(rosterBlock) +
      estimateTokens(episodeBlock) +
      estimateTokens(npcBlock) +
      estimateTokens(sceneCardBlock) +
      estimateTokens(npcCardBlock) +
      estimateTokens(advisedBlock) +
      estimateTokens(freshnessBlock) +
      estimateTokens(mappingsText) +
      toolTokens;

    const availableForTranscript = Math.max(0, maxTokens - fixedTokens - BUDGET_RESPONSE_RESERVE);

    // Filter transcript to window
    const windowMs = config.transcriptWindowMinutes * 60_000;
    const now = Date.now();
    const windowedSegments = transcriptSegments.filter(s => {
      const segTime = new Date(s.timestamp).getTime();
      return (now - segTime) <= windowMs;
    });

    const recentTranscript = this.buildTranscriptText(windowedSegments, availableForTranscript);

    // Update transcript freshness
    if (windowedSegments.length > 0) {
      const latest = windowedSegments[windowedSegments.length - 1];
      this.pacing.updateTranscriptFreshness(0, latest.timestamp);
    }

    // ── Compose dynamic context (user message) ─────────────────────────

    const contextParts = [
      `## Trigger\n${triggerSummary}`,
      freshnessBlock ? `## Data Freshness\n${freshnessBlock}` : '',
      `## Pacing State\n${pacingBlock}`,
      `## Episode Plan (Current Act)\n${episodeBlock}`,
      sceneCardBlock ? `## Pre-Fetched Scene Card\nFull content from the matched scene card. Use this for read-aloud text, objectives, and setup notes.\n\n${sceneCardBlock}` : '',
      npcCardBlock ? `## Pre-Fetched NPC Card\nFull character card for the NPC just mentioned. Use this for voice, personality, and relationships.\n\n${npcCardBlock}` : '',
      `## Character Roster\n${rosterBlock}`,
      npcBlock ? `## NPC Reference (Pre-Cached)\n${npcBlock}` : '',
      mappingsText ? `## Player Identity Mappings\n${mappingsText}` : '',
      advisedBlock ? `## ${advisedBlock}` : '',
      `## Recent Transcript\n${recentTranscript}`,
    ].filter(Boolean).join('\n\n');

    const totalTokens = estimateTokens(systemPrompt) + estimateTokens(contextParts) + toolTokens;

    this.pacing.markAssembled();
    logger.info(`ContextAssembler: assembled ${totalTokens} estimated tokens (budget: ${maxTokens})`);

    if (totalTokens > maxTokens) {
      logger.warn(`ContextAssembler: OVER BUDGET — ${totalTokens} > ${maxTokens}`);
    }

    return {
      systemPrompt,
      triggerSummary,
      recentTranscript,
      gameState: contextParts,
      pacingState: this.pacing.state,
      freshness: this.pacing.freshness,
      alreadyAdvised: [...this.memory.entries],
      npcCache: this.npcCache.length > 0 ? this.npcCache : undefined,
      sceneIndex: this.sceneIndex.length > 0 ? this.sceneIndex : undefined,
      tools,
      estimatedTokens: totalTokens,
    };
  }

  // ── Component Builders ──────────────────────────────────────────────────

  private buildPacingBlock(): string {
    const s = this.pacing.state;
    return JSON.stringify({
      assistant_state: s.assistant_state,
      current_act: s.current_act,
      current_scene: s.current_scene,
      current_thread: s.current_thread,
      act_timing: s.act_timing,
      scene_timing: s.scene_timing,
      next_planned_beat: s.next_planned_beat,
      spotlight_debt: s.spotlight_debt,
      players_without_recent_spotlight: s.players_without_recent_spotlight,
      engagement_signals: s.engagement_signals,
      separation_status: s.separation_status,
      climax_proximity: s.climax_proximity,
    }, null, 0); // Compact JSON — saves tokens
  }

  /**
   * Compress the full game state actor roster to names, roles, key aspects,
   * current FP, and active consequences only.
   */
  private buildCompressedRoster(gameStateJson: string): string {
    try {
      const state = JSON.parse(gameStateJson);
      const actors: unknown[] = state.actors || [];
      if (actors.length === 0) return 'No actors loaded.';

      const compressed = (actors as Array<Record<string, unknown>>).map(actor => {
        const aspects = (actor.aspects as Array<{ name: string; type: string }>) || [];
        const highConcept = aspects.find(a => a.type === 'High Concept')?.name || '';
        const trouble = aspects.find(a => a.type === 'Trouble')?.name || '';
        const tracks = (actor.tracks as Array<{ name: string; value: unknown }>) || [];
        const consequences = tracks
          .filter(t => /consequence/i.test(t.name))
          .filter(t => {
            const val = t.value;
            if (Array.isArray(val)) return val.some(Boolean);
            return Boolean(val);
          });

        return {
          name: actor.name,
          type: actor.type,
          highConcept,
          trouble,
          fp: actor.fatePoints ?? '?',
          consequences: consequences.map(c => c.name),
        };
      });

      const text = compressed.map(a => {
        let line = `- **${a.name}** (${a.type}): ${a.highConcept}`;
        if (a.trouble) line += ` / ${a.trouble}`;
        line += ` — FP: ${a.fp}`;
        if (a.consequences.length > 0) line += ` — Consequences: ${a.consequences.join(', ')}`;
        return line;
      }).join('\n');

      return this.truncateToTokens(text, BUDGET_ROSTER);
    } catch {
      return 'Failed to parse character roster.';
    }
  }

  /** Build compact NPC reference from pre-cache. Full briefs for unserved, names-only for served. */
  private buildNpcBlock(): string {
    if (this.npcCache.length === 0) return '';
    const unserved = this.npcCache.filter(n => !n.served);
    const served = this.npcCache.filter(n => n.served);
    const lines: string[] = [];
    for (const npc of unserved) {
      lines.push(`- ${npc.brief} [not yet appeared]`);
    }
    if (served.length > 0) {
      lines.push(`- Already appeared: ${served.map(n => n.display_name).join(', ')}`);
    }
    return this.truncateToTokens(lines.join('\n'), BUDGET_NPC_CACHE);
  }

  private buildAlreadyAdvisedBlock(): string {
    const block = this.memory.formatForContext();
    if (!block) return '';
    return this.truncateToTokens(block, BUDGET_ALREADY_ADVISED);
  }

  private buildFreshnessWarnings(): string {
    const stale = this.pacing.staleSources();
    if (stale.length === 0) return '';
    return stale.map(s => `[DATA STALE] ${s} data may be outdated`).join('\n');
  }

  private buildMappingsText(): string {
    const config = getConfig();
    const mappings = config.userMappings;
    if (Object.keys(mappings).length === 0) return '';
    return Object.entries(mappings)
      .map(([discord, character]) => `- ${discord} → ${character}`)
      .join('\n');
  }

  // ── Transcript Builder ──────────────────────────────────────────────────

  private buildTranscriptText(
    segments: Array<{ text: string; userId?: string; displayName?: string; timestamp: string }>,
    maxTokens: number,
  ): string {
    if (segments.length === 0) return 'No recent transcript.';

    const lines = segments.map(s => {
      const speaker = s.displayName ?? s.userId ?? 'Unknown';
      return `[${s.timestamp}] ${speaker}: ${s.text}`;
    });

    // Build from newest, prepending until budget exhausted
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

  // ── Helpers ─────────────────────────────────────────────────────────────

  private stripHtml(text: string): string {
    return text.replace(/<[^>]*>/g, '');
  }

  private truncateToTokens(text: string, maxTokens: number): string {
    if (estimateTokens(text) <= maxTokens) return text;
    // Truncate at char level (rough)
    const maxChars = maxTokens * 4;
    return text.slice(0, maxChars) + '\n...[truncated]';
  }

  private summarizeTriggers(batch: TriggerBatch): string {
    if (batch.events.length === 0) return 'No specific triggers.';

    const parts: string[] = [];
    for (const event of batch.events) {
      switch (event.type) {
        case 'gm_question':
          parts.push(`P1 — GM question: "${(event.data.transcript as string)?.slice(0, 200) ?? ''}"`);
          break;
        case 'gm_hesitation':
          parts.push(
            `P1-H — GM hesitation gap-fill: "${(event.data.transcript as string)?.slice(0, 200) ?? ''}" ` +
            `(${event.data.silenceSeconds}s silence). Respond with category "gap-fill": a single short line with the most likely missing piece.`
          );
          break;
        case 'scene_transition':
          parts.push(`P2 — Scene transition (source: ${event.source})`);
          break;
        case 'scene_transition_detected':
          parts.push(
            `P2 — Scene detected from keywords: "${event.data.scene_title}" ` +
            `(matched: ${(event.data.matched_keywords as string[])?.join(', ') ?? ''}). ` +
            `The scene card has been pre-fetched below — use it for read-aloud text, objectives, and setup notes.`
          );
          break;
        case 'npc_first_appearance': {
          const pron = event.data.npc_pronunciation ? ` (${event.data.npc_pronunciation})` : '';
          parts.push(
            `P2 — NPC first appearance: ${event.data.npc_name}${pron}. ` +
            `Brief: ${event.data.npc_brief}. ` +
            `Full character card has been pre-fetched below.`
          );
          break;
        }
        case 'act_transition':
          parts.push(`P2 — Act transition (source: ${event.source})`);
          break;
        case 'pacing_gate_convergence':
          parts.push(
            `P2 — Convergence gate: ${event.data.remaining_minutes}min remaining. ` +
            (event.data.escalation
              ? `ESCALATION: Still in Act ${event.data.current_act}, need to accelerate toward climax.`
              : `Open threads: ${(event.data.open_threads as string[])?.join(', ') || 'none tracked'}.`)
          );
          break;
        case 'pacing_gate_denouement':
          parts.push(`P2 — Denouement gate: ${event.data.remaining_minutes}min remaining. Time to wrap up and land the ending.`);
          break;
        case 'pacing_alert':
          parts.push(`P3 — Scene overrun: ${event.data.elapsed}min / ${event.data.planned}min planned`);
          break;
        case 'silence_detection':
          parts.push(`P4 — GM silence: ${event.data.silenceSeconds}s`);
          break;
      }
    }

    return parts.join('\n');
  }
}

const DEFAULT_SYSTEM_PROMPT = `You are a production stage manager and creative collaborator assisting a Fate Core GM during a live tabletop RPG session. Respond with a JSON advice envelope or NO_ADVICE sentinel. Keep messages under 100 words.`;
