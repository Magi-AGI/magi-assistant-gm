/**
 * v7: Whisper pre-staging.
 *
 * Scans beat/scene cards for planned whisper content (private messages to
 * specific players). Pre-loads into a queue and notifies the GM when
 * corresponding scenes activate. The GM confirms delivery via /send.
 */

import { logger } from '../logger.js';
import type { McpAggregator } from '../mcp/client.js';
import type { WhisperStageEntry } from '../types/index.js';

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
  } catch { /* not JSON */ }
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

// ── Whisper detection patterns ──

/**
 * Patterns to detect whisper/private content and extract target + text.
 * Group 1: target player/character name. Group 2: whisper text.
 */
const WHISPER_PATTERNS = [
  /(?:whisper|private)\s+to\s+([\w\s]+?):\s*(.+)/i,
  /(?:whisper|private)\s+to\s+([\w\s]+?)\s*[—–-]\s*(.+)/i,
  /→\s*([\w\s]+?):\s*(.+)/,
];

/** Extract whisper entries from HTML, including blockquote-based whispers. */
function extractWhispers(html: string, sceneId: string, sourceCard: string): WhisperStageEntry[] {
  const entries: WhisperStageEntry[] = [];
  const seen = new Set<string>();

  // Strategy 1: Headings that mention "Whisper to" or "Private to"
  const headingPattern = /<(?:h[1-6]|strong|b)[^>]*>([^<]*(?:whisper|private)\s+to\s+[\w\s]+[^<]*)<\/(?:h[1-6]|strong|b)>/gi;
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = headingPattern.exec(html)) !== null) {
    const headingText = headingMatch[1];

    // Extract target from heading — try full patterns first, then simpler extraction
    let target: string | null = null;
    let inlineText: string | null = null;
    for (const pat of WHISPER_PATTERNS) {
      const m = headingText.match(pat);
      if (m) {
        target = m[1].trim();
        inlineText = m[2]?.trim() || null;
        break;
      }
    }
    // Fallback: "Whisper to Name:" or "Private to Name" without content after colon
    if (!target) {
      const simpleMatch = headingText.match(/(?:whisper|private)\s+to\s+([\w\s]+?)(?:\s*[:—–-]\s*)?$/i);
      if (simpleMatch) {
        target = simpleMatch[1].trim();
      }
    }

    if (target && !seen.has(target.toLowerCase())) {
      // Extract content after this heading until next heading
      const afterHeading = html.slice(headingMatch.index + headingMatch[0].length);
      const nextHeadingIdx = afterHeading.search(/<(?:h[1-6]|hr)[^>]*>/i);
      const sectionHtml = nextHeadingIdx >= 0 ? afterHeading.slice(0, nextHeadingIdx) : afterHeading.slice(0, 2000);
      const text = stripHtml(sectionHtml).trim();
      if (text) {
        seen.add(target.toLowerCase());
        entries.push(makeEntry(target, inlineText || summarize(text), text, sceneId, sourceCard));
      }
    }
  }

  // Strategy 2: Blockquotes with player attribution
  const blockquotePattern = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi;
  let bqMatch: RegExpExecArray | null;
  while ((bqMatch = blockquotePattern.exec(html)) !== null) {
    const bqHtml = bqMatch[1];
    const bqText = stripHtml(bqHtml).trim();
    if (!bqText) continue;

    // Check if preceding text mentions a whisper target
    const preceding = html.slice(Math.max(0, bqMatch.index - 300), bqMatch.index);
    const precedingText = stripHtml(preceding);
    for (const pat of WHISPER_PATTERNS) {
      const m = precedingText.match(pat);
      if (m) {
        const target = m[1].trim();
        if (!seen.has(target.toLowerCase())) {
          seen.add(target.toLowerCase());
          entries.push(makeEntry(target, summarize(bqText), bqText, sceneId, sourceCard));
        }
        break;
      }
    }
  }

  // Strategy 3: Inline text patterns
  const plainText = stripHtml(html);
  for (const line of plainText.split('\n')) {
    for (const pat of WHISPER_PATTERNS) {
      const m = line.match(pat);
      if (m) {
        const target = m[1].trim();
        const text = m[2].trim();
        if (text && !seen.has(target.toLowerCase())) {
          seen.add(target.toLowerCase());
          entries.push(makeEntry(target, summarize(text), text, sceneId, sourceCard));
        }
        break;
      }
    }
  }

  return entries;
}

function makeEntry(
  target: string,
  description: string,
  text: string,
  sceneId: string,
  sourceCard: string,
): WhisperStageEntry {
  return {
    id: slugify(`${sceneId}-${target}`),
    target,
    description,
    text,
    sceneKeywords: extractSceneKeywords(sourceCard),
    sourceCard,
    notified: false,
    sent: false,
  };
}

/** Create a short summary from whisper text (first 10 words). */
function summarize(text: string): string {
  const words = text.split(/\s+/).slice(0, 10);
  return words.join(' ') + (text.split(/\s+/).length > 10 ? '...' : '');
}

/** Extract keywords from card path for scene matching. */
function extractSceneKeywords(cardPath: string): string[] {
  const segments = cardPath.split('+');
  const lastSegment = segments[segments.length - 1].replace(/_/g, ' ').toLowerCase();
  return lastSegment
    .split(/\s+/)
    .filter(w => w.length >= 4)
    .slice(0, 10);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Builder ──

export class WhisperStager {
  constructor(private mcp: McpAggregator) {}

  /**
   * Scan beat cards for whisper/private content.
   * Returns entries keyed by scene keywords.
   */
  async build(beatCardPaths: string[]): Promise<WhisperStageEntry[]> {
    if (beatCardPaths.length === 0) return [];

    const entries: WhisperStageEntry[] = [];

    const results = await Promise.allSettled(
      beatCardPaths.map(path => this.processCard(path)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        entries.push(...result.value);
      }
    }

    logger.info(`WhisperStager: complete — ${entries.length} whispers from ${beatCardPaths.length} cards`);
    return entries;
  }

  private async processCard(cardPath: string): Promise<WhisperStageEntry[]> {
    try {
      const result = await this.mcp.callTool('wiki__get_card', {
        name: cardPath,
        max_content_length: 8000,
      });
      const html = extractCardHtml(result);
      if (!html) return [];

      const segments = cardPath.split('+');
      const sceneId = segments[segments.length - 1]
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');

      return extractWhispers(html, sceneId, cardPath);
    } catch (err) {
      logger.debug(`WhisperStager: failed to process "${cardPath}":`, err);
      return [];
    }
  }
}

// Exported for testing
export { extractWhispers };
