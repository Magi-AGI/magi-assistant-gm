/**
 * v7: Beat reminder cache builder.
 *
 * Fetches beat/scene cards discovered by plan discovery, extracts GM Notes
 * sections, and compresses them into bullet-point reminders for proactive
 * delivery when scenes trigger. Content is pre-composed (not LLM-generated).
 */

import { logger } from '../logger.js';
import type { McpAggregator } from '../mcp/client.js';
import type { BeatReminderEntry } from '../types/index.js';

// ── MCP extraction helpers (inline, following existing duplication pattern) ──

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

// ── GM Notes heading detection ──

/**
 * Regex matching HTML headings that contain GM-facing note keywords.
 * Matches <h1> through <h6> and <strong>/<b> variants.
 */
const GM_NOTES_HEADING_RE = /<(?:h[1-6]|strong|b)[^>]*>([^<]*(?:GM\s+Notes?|What\s+NOT\s+to|Hard\s+Gates?|Don['']?t|Remember|Director['']?s?\s+Notes?)[^<]*)<\/(?:h[1-6]|strong|b)>/gi;

/**
 * Extract GM Notes sections from HTML content.
 * Returns the text content between each matched heading and the next heading.
 */
function extractGmNotesSections(html: string): string[] {
  const sections: string[] = [];

  // Find all GM Notes heading positions
  const headingPositions: { index: number; length: number }[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(GM_NOTES_HEADING_RE.source, GM_NOTES_HEADING_RE.flags);
  while ((match = re.exec(html)) !== null) {
    headingPositions.push({ index: match.index, length: match[0].length });
  }

  if (headingPositions.length === 0) return sections;

  // For each matched heading, extract text until the next heading of any level
  const nextHeadingRe = /<(?:h[1-6]|hr)[^>]*>/i;

  for (const pos of headingPositions) {
    const contentStart = pos.index + pos.length;
    const remaining = html.slice(contentStart);
    const nextMatch = nextHeadingRe.exec(remaining);
    const sectionHtml = nextMatch ? remaining.slice(0, nextMatch.index) : remaining;
    const plainText = stripHtml(sectionHtml).trim();
    if (plainText) {
      sections.push(plainText);
    }
  }

  return sections;
}

/**
 * Compress GM Notes sections into short bullets.
 * Each bullet is trimmed to maxWords.
 */
function compressToBullets(sections: string[], maxBullets: number, maxWordsPerBullet = 25): string[] {
  const bullets: string[] = [];

  for (const section of sections) {
    // Split by line breaks and list markers
    const lines = section
      .split(/\n/)
      .map(l => l.replace(/^[-*•]\s*/, '').trim())
      .filter(l => l.length > 0);

    for (const line of lines) {
      if (bullets.length >= maxBullets) break;

      // Trim to maxWords
      const words = line.split(/\s+/);
      const trimmed = words.length > maxWordsPerBullet
        ? words.slice(0, maxWordsPerBullet).join(' ') + '...'
        : words.join(' ');

      bullets.push(trimmed);
    }

    if (bullets.length >= maxBullets) break;
  }

  return bullets;
}

// ── Keyword extraction (simplified from scene-index.ts) ──

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

function extractKeywords(plainText: string, minLength = 4): string[] {
  const keywords = new Set<string>();

  // Proper nouns
  const properNounPattern = /(?<=[a-zA-Z,.!?]\s+)([A-Z][a-z]{2,})/g;
  let match: RegExpExecArray | null;
  while ((match = properNounPattern.exec(plainText)) !== null) {
    const word = match[1].toLowerCase();
    if (word.length >= minLength && !STOP_WORDS.has(word)) {
      keywords.add(word);
    }
  }

  // All-caps words
  const allCapsPattern = /\b([A-Z]{3,})\b/g;
  while ((match = allCapsPattern.exec(plainText)) !== null) {
    keywords.add(match[1].toLowerCase());
  }

  // Hyphenated compounds
  const hyphenPattern = /\b([A-Za-z]+-[A-Za-z]+(?:-[A-Za-z]+)*)\b/g;
  while ((match = hyphenPattern.exec(plainText)) !== null) {
    if (match[1].length >= minLength) {
      keywords.add(match[1].toLowerCase());
    }
  }

  return [...keywords].slice(0, 15);
}

/** Derive a scene ID from a card path (last segment, slugified). */
function titleToId(cardPath: string): string {
  const segments = cardPath.split('+');
  return segments[segments.length - 1]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Extract display title from card path (last segment, cleaned). */
function cardPathToTitle(cardPath: string): string {
  const segments = cardPath.split('+');
  return segments[segments.length - 1].replace(/_/g, ' ');
}

// ── Builder ──

export class BeatCacheBuilder {
  constructor(
    private mcp: McpAggregator,
    private maxBullets = 3,
  ) {}

  /**
   * Build beat reminder cache from discovered beat card paths.
   * For each card: fetch → extract GM Notes → compress to bullets.
   * Cards without GM Notes sections are skipped.
   */
  async build(beatCardPaths: string[]): Promise<BeatReminderEntry[]> {
    if (beatCardPaths.length === 0) return [];

    const entries: BeatReminderEntry[] = [];

    const results = await Promise.allSettled(
      beatCardPaths.map(path => this.processCard(path)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        entries.push(result.value);
      }
    }

    logger.info(`BeatCacheBuilder: complete — ${entries.length} entries from ${beatCardPaths.length} cards`);
    return entries;
  }

  private async processCard(cardPath: string): Promise<BeatReminderEntry | null> {
    try {
      const result = await this.mcp.callTool('wiki__get_card', {
        name: cardPath,
        max_content_length: 8000,
      });
      const html = extractCardHtml(result);
      if (!html) return null;

      const sections = extractGmNotesSections(html);
      if (sections.length === 0) return null;

      const bullets = compressToBullets(sections, this.maxBullets);
      if (bullets.length === 0) return null;

      const plainText = stripHtml(html);
      const keywords = extractKeywords(plainText);

      return {
        sceneId: titleToId(cardPath),
        sceneTitle: cardPathToTitle(cardPath),
        sourceCard: cardPath,
        bullets,
        keywords,
        served: false,
        servedAt: null,
      };
    } catch (err) {
      logger.debug(`BeatCacheBuilder: failed to process "${cardPath}":`, err);
      return null;
    }
  }
}

// Exported for testing
export { extractGmNotesSections, compressToBullets, extractKeywords, titleToId };
