/**
 * v3: NPC pre-cache builder.
 *
 * On ACTIVE transition, fetches NPC cards linked from the episode plan,
 * generates compressed briefs (deterministic, no LLM call), and stores
 * them for instant serving on first NPC mention in transcript.
 */

import { logger } from '../logger.js';
import type { McpAggregator } from '../mcp/client.js';
import type { NpcCacheEntry } from '../types/index.js';

/**
 * Extract text content from an MCP callTool result.
 * The MCP SDK returns { content: [{ type: "text", text: "..." }] }.
 */
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

/**
 * Extract HTML content from a wiki get_card result.
 * The MCP text may be a JSON envelope like {"id":...,"text":"<html>..."}
 * or raw HTML. Handles both cases.
 */
function extractCardHtml(result: unknown): string | null {
  const text = extractMcpText(result);
  if (!text) return null;

  // Try JSON envelope: {"id":..., "text":"<html>..."}
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.text === 'string') {
      return parsed.text;
    }
  } catch {
    // Not JSON — treat as raw HTML content
  }

  return text;
}

/** Extract <a href="/..."> links from HTML content. */
function extractWikiLinks(html: string): string[] {
  const links: string[] = [];
  const pattern = /href="\/([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    // Decode URL-encoded card names (spaces as +, apostrophes, etc.)
    const decoded = decodeURIComponent(match[1].replace(/\+/g, ' '));
    links.push(decoded);
  }
  return [...new Set(links)];
}

/** Strip HTML tags to get plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Try to extract a pronunciation guide from text, e.g. "(dow-KRESH)". */
function extractPronunciation(text: string, name: string): string {
  // Pattern: name followed by (PRONUNCIATION) — common wiki format
  const nameEscaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const afterName = new RegExp(`${nameEscaped}\\s*\\(([^)]{2,30})\\)`, 'i');
  const match = text.match(afterName);
  if (match) return match[1].trim();

  // Fallback: any standalone (ALL-CAPS-WITH-DASHES) pattern
  const capsPattern = /\(([A-Z][A-Za-z-]+(?:\s[A-Z][A-Za-z-]+)*)\)/;
  const capMatch = text.match(capsPattern);
  if (capMatch) return capMatch[1].trim();

  return '';
}

/** Extract the display name from a card path (last segment). */
function cardPathToName(cardPath: string): string {
  const segments = cardPath.split('+');
  return segments[segments.length - 1].replace(/_/g, ' ');
}

/**
 * Heuristic: does this card look like an NPC/character card?
 * Checks path segments and content for character-like attributes.
 */
function isLikelyNpcCard(cardPath: string, content: string): boolean {
  const pathLower = cardPath.toLowerCase();

  // Path-based heuristics
  if (pathLower.includes('character') || pathLower.includes('npc')) return true;

  // Content-based heuristics (common character card attributes)
  const contentLower = content.toLowerCase();
  const npcIndicators = [
    'species', 'race', 'pronunciation', 'voice', 'personality',
    'high concept', 'trouble', 'aspect', 'skill', 'stunt',
  ];
  const matchCount = npcIndicators.filter(ind => contentLower.includes(ind)).length;
  return matchCount >= 2;
}

/** Build a compressed brief from card content. Target: ≤maxWords words. */
function buildBrief(name: string, pronunciation: string, plainText: string, maxWords: number): string {
  // Start with name and pronunciation
  const header = pronunciation ? `${name.toUpperCase()} (${pronunciation})` : name.toUpperCase();

  // Take the first meaningful lines of content, skipping the title/header
  const lines = plainText.split('\n').filter(l => l.trim().length > 0);
  // Skip lines that are just the card name repeated
  const nameLower = name.toLowerCase();
  const contentLines = lines.filter(l => l.trim().toLowerCase() !== nameLower);

  // Collect words up to budget
  const words: string[] = [];
  for (const line of contentLines) {
    for (const word of line.split(/\s+/)) {
      if (words.length >= maxWords) break;
      words.push(word);
    }
    if (words.length >= maxWords) break;
  }

  const body = words.join(' ');
  return body ? `${header} — ${body}` : header;
}

/** Build a list of lowercase aliases for fuzzy matching an NPC name in transcript. */
function buildAliases(name: string, cardPath: string): string[] {
  const aliases: string[] = [];
  const nameLower = name.toLowerCase();

  aliases.push(nameLower);

  // Split hyphenated or multi-word names
  if (nameLower.includes('-')) {
    for (const part of nameLower.split('-')) {
      if (part.length >= 3) aliases.push(part);
    }
  }
  if (nameLower.includes(' ')) {
    for (const part of nameLower.split(/\s+/)) {
      if (part.length >= 3) aliases.push(part);
    }
  }

  // Use the last path segment (may differ from display name due to encoding)
  const segments = cardPath.split('+');
  const pathName = segments[segments.length - 1].replace(/_/g, ' ').toLowerCase();
  if (pathName !== nameLower) {
    aliases.push(pathName);
  }

  return [...new Set(aliases)];
}

export class NpcCacheBuilder {
  constructor(
    private mcp: McpAggregator,
    private maxBriefWords: number,
  ) {}

  /**
   * Build NPC cache from the episode plan card and its linked cards.
   * Returns entries sorted by name. Non-throwing: logs errors and returns
   * partial results.
   */
  async build(episodePlanCard: string): Promise<NpcCacheEntry[]> {
    logger.info(`NpcCacheBuilder: building from "${episodePlanCard}"`);
    const entries: NpcCacheEntry[] = [];

    try {
      // 1. Fetch episode plan + children to find all linked cards
      const allLinks = await this.collectLinksFromPlanTree(episodePlanCard);
      logger.info(`NpcCacheBuilder: found ${allLinks.length} unique linked cards`);

      // 2. Fetch each linked card and check if it's an NPC
      const fetches = allLinks.map(link => this.tryFetchNpcCard(link));
      const results = await Promise.allSettled(fetches);

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          entries.push(result.value);
        }
      }

      logger.info(`NpcCacheBuilder: cached ${entries.length} NPC briefs`);
    } catch (err) {
      logger.error('NpcCacheBuilder: build failed:', err);
    }

    return entries.sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  /** Collect all wiki links from the plan card and its children (depth 2). */
  private async collectLinksFromPlanTree(planCard: string): Promise<string[]> {
    const allLinks = new Set<string>();

    // Fetch the plan card itself
    const planContent = await this.fetchCardContent(planCard);
    if (planContent) {
      for (const link of extractWikiLinks(planContent)) {
        allLinks.add(link);
      }
    }

    // Fetch children (acts, scenes)
    try {
      const childrenRaw = await this.mcp.callTool('wiki__list_children', {
        parent_name: planCard,
        depth: 2,
        limit: 50,
      });
      const childrenText = extractMcpText(childrenRaw);
      let children: Array<{ id: string }> = [];
      if (childrenText) {
        try {
          const parsed = JSON.parse(childrenText);
          children = Array.isArray(parsed) ? parsed : (parsed?.results ?? []);
        } catch { /* invalid JSON — treat as no children */ }
      }
      // Fetch each child card to extract its links
      const childFetches = children.map(async (child) => {
        const content = await this.fetchCardContent(child.id);
        if (content) {
          for (const link of extractWikiLinks(content)) {
            allLinks.add(link);
          }
        }
      });
      await Promise.allSettled(childFetches);
    } catch (err) {
      logger.warn('NpcCacheBuilder: failed to list children:', err);
    }

    // Remove self-references
    allLinks.delete(planCard);

    return [...allLinks];
  }

  /** Fetch a card's HTML content. Returns null on failure. */
  private async fetchCardContent(cardName: string): Promise<string | null> {
    try {
      const result = await this.mcp.callTool('wiki__get_card', {
        name: cardName,
        max_content_length: 8000,
      });
      return extractCardHtml(result);
    } catch {
      return null;
    }
  }

  /** Try to build an NPC cache entry from a card. Returns null if not an NPC. */
  private async tryFetchNpcCard(cardPath: string): Promise<NpcCacheEntry | null> {
    const content = await this.fetchCardContent(cardPath);
    if (!content) return null;

    const plainText = stripHtml(content);
    if (!isLikelyNpcCard(cardPath, plainText)) return null;

    const displayName = cardPathToName(cardPath);
    const pronunciation = extractPronunciation(plainText, displayName);
    const brief = buildBrief(displayName, pronunciation, plainText, this.maxBriefWords);
    const aliases = buildAliases(displayName, cardPath);

    return {
      key: displayName.toLowerCase(),
      display_name: displayName,
      pronunciation,
      brief,
      full_card: cardPath,
      aliases,
      served: false,
      last_served_at: null,
    };
  }
}
