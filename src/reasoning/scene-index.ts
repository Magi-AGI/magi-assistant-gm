/**
 * v3: Scene index builder.
 *
 * Parses the episode plan card tree into a keyword-indexed scene list.
 * When transcript keywords match an unserved scene, the trigger detector
 * can proactively serve the scene brief.
 */

import { logger } from '../logger.js';
import type { McpAggregator } from '../mcp/client.js';
import type { SceneIndexEntry } from '../types/index.js';

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
    .trim();
}

/** Extract <a href="/..."> link target names from HTML. */
function extractLinkedNames(html: string): string[] {
  const names: string[] = [];
  const pattern = /href="\/([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const decoded = decodeURIComponent(match[1].replace(/\+/g, ' '));
    const segments = decoded.split('+');
    const name = segments[segments.length - 1].replace(/_/g, ' ');
    names.push(name.toLowerCase());
  }
  return names;
}

/** Common English words to exclude from keyword extraction. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those',
  'it', 'its', 'they', 'them', 'their', 'we', 'our', 'you', 'your',
  'he', 'she', 'his', 'her', 'not', 'no', 'if', 'then', 'than',
  'so', 'as', 'up', 'out', 'about', 'into', 'over', 'after', 'before',
  'between', 'under', 'again', 'further', 'also', 'just', 'more',
  'all', 'each', 'every', 'both', 'few', 'some', 'any', 'most', 'other',
  'new', 'old', 'first', 'last', 'long', 'great', 'little', 'own',
  'same', 'big', 'small', 'right', 'see', 'now', 'way', 'here',
  'when', 'where', 'how', 'what', 'who', 'which', 'one', 'two', 'three',
  'act', 'scene', 'note', 'notes', 'card', 'plan', 'planned', 'episode',
]);

/**
 * Extract distinctive keywords from text.
 * Focuses on proper nouns, linked card names, and distinctive content words.
 * Returns lowercase keywords.
 */
function extractKeywords(plainText: string, linkedNames: string[], minLength: number): string[] {
  const keywords = new Set<string>();

  // Add linked card names (high value — these are direct references)
  for (const name of linkedNames) {
    if (name.length >= minLength) {
      keywords.add(name);
    }
    // Also add individual words from multi-word names
    for (const word of name.split(/\s+/)) {
      if (word.length >= minLength && !STOP_WORDS.has(word)) {
        keywords.add(word);
      }
    }
  }

  // Extract proper nouns: words starting with uppercase that aren't sentence-starts.
  // Matches after both lowercase AND uppercase letters (so "Captain Daokresh" → both).
  const properNounPattern = /(?<=[a-zA-Z,.!?]\s+)([A-Z][a-z]{2,})/g;
  let match: RegExpExecArray | null;
  while ((match = properNounPattern.exec(plainText)) !== null) {
    const word = match[1].toLowerCase();
    if (word.length >= minLength && !STOP_WORDS.has(word)) {
      keywords.add(word);
    }
  }

  // Also grab all-caps words (often NPC titles, locations, etc.)
  const allCapsPattern = /\b([A-Z]{3,})\b/g;
  while ((match = allCapsPattern.exec(plainText)) !== null) {
    keywords.add(match[1].toLowerCase());
  }

  // Extract hyphenated compound words (common for sci-fi names)
  const hyphenPattern = /\b([A-Za-z]+-[A-Za-z]+(?:-[A-Za-z]+)*)\b/g;
  while ((match = hyphenPattern.exec(plainText)) !== null) {
    if (match[1].length >= minLength) {
      keywords.add(match[1].toLowerCase());
    }
  }

  return [...keywords].slice(0, 15); // Cap at 15 keywords per scene
}

/** Derive a scene ID from a card title. */
function titleToId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export class SceneIndexBuilder {
  constructor(
    private mcp: McpAggregator,
    private minKeywordLength = 4,
  ) {}

  /**
   * Build a scene index from the episode plan card tree.
   * Each child card of the plan is treated as a scene/act entry.
   * Returns entries in tree order. Non-throwing.
   */
  async build(episodePlanCard: string): Promise<SceneIndexEntry[]> {
    logger.info(`SceneIndexBuilder: building from "${episodePlanCard}"`);
    const entries: SceneIndexEntry[] = [];

    try {
      // Get the plan's child cards (acts, scenes, cold opens, etc.)
      const childrenRaw = await this.mcp.callTool('wiki__list_children', {
        parent_name: episodePlanCard,
        depth: 2,
        limit: 50,
      });
      const childrenText = extractMcpText(childrenRaw);
      let children: Array<{ id: string; title: string }> = [];
      if (childrenText) {
        try {
          const parsed = JSON.parse(childrenText);
          children = Array.isArray(parsed) ? parsed : (parsed?.results ?? []);
        } catch { /* invalid JSON — treat as no children */ }
      }
      if (children.length === 0) {
        logger.warn('SceneIndexBuilder: no child cards found');
        return entries;
      }

      // Fetch each child card and extract keywords
      for (const child of children) {
        try {
          const entry = await this.buildEntry(child.id, child.title);
          if (entry && entry.keywords.length >= 2) {
            entries.push(entry);
          }
        } catch (err) {
          logger.warn(`SceneIndexBuilder: failed to process "${child.title}":`, err);
        }
      }

      logger.info(`SceneIndexBuilder: indexed ${entries.length} scenes`);
    } catch (err) {
      logger.error('SceneIndexBuilder: build failed:', err);
    }

    return entries;
  }

  /** Build a scene index entry from a single card. */
  private async buildEntry(cardPath: string, title: string): Promise<SceneIndexEntry | null> {
    const result = await this.mcp.callTool('wiki__get_card', {
      name: cardPath,
      max_content_length: 8000,
    });

    const html = extractCardHtml(result);
    if (!html) return null;

    const plainText = stripHtml(html);
    const linkedNames = extractLinkedNames(html);

    // Extract the display title (last path segment, cleaned up)
    const segments = title.split('+');
    const displayTitle = segments[segments.length - 1].replace(/_/g, ' ').trim();

    const keywords = extractKeywords(plainText, linkedNames, this.minKeywordLength);

    // Extract likely NPC references from linked names (best-effort heuristic).
    // Filters out obvious non-NPC linked cards (structural terms, short terms).
    const npcs = linkedNames.filter(name => {
      if (name.length < 3) return false;
      const words = name.split(/\s+/);
      // Single-word names: skip stop words
      if (words.length === 1 && STOP_WORDS.has(name)) return false;
      // Multi-word names starting with structural terms
      if (/^(?:act|scene|session|episode|chapter|part|rules?|fate|core)\s/i.test(name)) return false;
      return true;
    });

    return {
      id: titleToId(displayTitle),
      title: displayTitle,
      card: cardPath,
      keywords,
      npcs,
      served: false,
      served_at: null,
    };
  }
}
