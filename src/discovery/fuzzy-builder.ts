/**
 * v4: Fuzzy match table builder.
 *
 * Builds the cumulative STT garble mapping table from three sources:
 * 1. Wiki card: Tools+Magi Assistant GM+Fuzzy Match Table (persistent, primary)
 * 2. Session logs: BG_SessionLog cards with STT Quality Issues sections
 * 3. Static JSON file: config/fuzzy-match.json (bootstrap seed / overrides)
 *
 * The merged table is used by auto-ACTIVE detection and NPC cache lookups.
 */

import { readFileSync } from 'node:fs';
import { logger } from '../logger.js';
import type { McpAggregator } from '../mcp/client.js';
import { extractMcpText } from '../reasoning/context.js';
import type { FuzzyMatchTable } from '../reasoning/triggers.js';

const FUZZY_WIKI_CARD = 'Tools+Magi Assistant GM+Fuzzy Match Table';

/** Parse search results from an MCP tool call response. */
function parseSearchResults(raw: unknown): Array<{ id: string; title: string }> {
  const text = extractMcpText(raw);
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    const results = Array.isArray(parsed) ? parsed : (parsed?.results ?? []);
    return results.map((r: Record<string, unknown>) => ({
      id: String(r.id ?? ''),
      title: String(r.title ?? r.id ?? ''),
    }));
  } catch {
    return [];
  }
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

/**
 * Parse the Fuzzy Match Table wiki card content.
 * The card uses HTML tables with Garble | Correct columns.
 */
function parseFuzzyWikiCard(text: string): FuzzyMatchTable {
  const table: FuzzyMatchTable = {};

  // Match table rows: <tr><td>garble</td><td>correct</td>...
  // Uses [^>]* to handle potential attributes on elements.
  // <th> rows (headers) won't match since we look for <td>.
  const rowPattern = /<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>/gi;
  let match: RegExpExecArray | null;

  while ((match = rowPattern.exec(text)) !== null) {
    const garble = match[1].trim().toLowerCase();
    const correct = match[2].trim();

    // Skip empty or very short entries
    if (!garble || garble.length < 2) continue;

    table[garble] = correct.toLowerCase();
  }

  return table;
}

/**
 * Extract STT quality issue mappings from a session log card's plain text.
 * Looks for "STT Quality Issues" sections with garble -> correct patterns.
 */
function parseSessionLogSttIssues(plainText: string): FuzzyMatchTable {
  const table: FuzzyMatchTable = {};

  const sectionStart = plainText.search(/stt\s+quality\s+issues?/i);
  if (sectionStart === -1) return table;

  // Extract the section (until next major heading or end)
  const sectionText = plainText.slice(sectionStart, sectionStart + 5000);

  // Match "garble" -> "correct" patterns:
  //   "Darwin" -> Darjin
  //   darwin: Darjin
  //   darwin => Darjin
  const mappingPattern = /[""]?([^""\n:->]+)[""]?\s*(?:->|=>|:)\s*[""]?([^""\n,]+)[""]?/g;
  let match: RegExpExecArray | null;

  while ((match = mappingPattern.exec(sectionText)) !== null) {
    const garble = match[1].trim().toLowerCase();
    const correct = match[2].trim();

    if (garble.length < 2 || correct.length < 2) continue;
    // Skip headings/metadata
    if (/^(session|episode|group|stt|quality|issues?|source|confidence)/i.test(garble)) continue;

    table[garble] = correct.toLowerCase();
  }

  return table;
}

/**
 * Load the static fuzzy match JSON file (bootstrap seed).
 * Returns empty table on failure.
 */
function loadStaticFuzzyTable(path: string): FuzzyMatchTable {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const table: FuzzyMatchTable = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith('_')) continue;
        if (typeof value === 'string') {
          table[key.toLowerCase()] = value.toLowerCase();
        }
      }
      return table;
    }
  } catch {
    // File may not exist -- that's fine for v4
  }
  return {};
}

export interface FuzzyBuildResult {
  table: FuzzyMatchTable;
  wikiCardEntries: number;
  sessionLogEntries: number;
  sessionLogCount: number;
  staticOverrides: number;
  total: number;
}

/**
 * Build the fuzzy match table from all three sources.
 * Merge order (later sources override earlier):
 * 1. Wiki card (persistent base)
 * 2. Session log discoveries (may have newer entries)
 * 3. Static JSON overrides (manual corrections)
 */
export async function buildFuzzyTable(
  mcp: McpAggregator,
  campaignSlug: string,
  staticPath?: string,
): Promise<FuzzyBuildResult> {
  const result: FuzzyBuildResult = {
    table: {},
    wikiCardEntries: 0,
    sessionLogEntries: 0,
    sessionLogCount: 0,
    staticOverrides: 0,
    total: 0,
  };

  // Source 1: Wiki card
  try {
    const cardRaw = await mcp.callTool('wiki__get_card', {
      name: FUZZY_WIKI_CARD,
      max_content_length: 0,
    });
    const cardText = extractMcpText(cardRaw);
    if (cardText) {
      const wikiEntries = parseFuzzyWikiCard(cardText);
      result.wikiCardEntries = Object.keys(wikiEntries).length;
      Object.assign(result.table, wikiEntries);
      logger.info(`FuzzyBuilder: ${result.wikiCardEntries} entries from wiki card`);
    }
  } catch (err) {
    logger.warn('FuzzyBuilder: failed to read wiki fuzzy table card:', err);
  }

  // Source 2: Session log cards
  try {
    const logsRaw = await mcp.callTool('wiki__search_by_tags', {
      tags: [`campaign:${campaignSlug}`],
      match_mode: 'all',
      limit: 50,
    });
    const allTagged = parseSearchResults(logsRaw);

    // Filter to session log cards
    const logCards = allTagged.filter(r =>
      /session\s+\d+\s+log/i.test(r.title) || /session\s+\d+\s+log/i.test(r.id)
    );

    // If tag search didn't find logs, try type search
    let sessionLogs = logCards;
    if (sessionLogs.length === 0) {
      try {
        const typeRaw = await mcp.callTool('wiki__search_cards', {
          query: 'Session Log',
          type: 'BG_SessionLog',
          search_in: 'name',
          limit: 20,
        });
        sessionLogs = parseSearchResults(typeRaw);
      } catch {
        // Type search may not work if BG_SessionLog type doesn't exist yet
      }
    }

    result.sessionLogCount = sessionLogs.length;

    // Fetch each log and extract STT quality issues
    const logFetches = sessionLogs.map(async (logCard) => {
      try {
        const logRaw = await mcp.callTool('wiki__get_card', {
          name: logCard.id,
          max_content_length: 0,
        });
        const logText = extractMcpText(logRaw);
        if (logText) {
          const plainText = stripHtml(logText);
          const logEntries = parseSessionLogSttIssues(plainText);
          const newCount = Object.keys(logEntries).length;
          if (newCount > 0) {
            Object.assign(result.table, logEntries);
            result.sessionLogEntries += newCount;
          }
        }
      } catch {
        logger.debug(`FuzzyBuilder: failed to process log "${logCard.title}"`);
      }
    });
    await Promise.allSettled(logFetches);

    if (result.sessionLogEntries > 0) {
      logger.info(`FuzzyBuilder: ${result.sessionLogEntries} entries from ${result.sessionLogCount} session logs`);
    }
  } catch (err) {
    logger.warn('FuzzyBuilder: failed to search session logs:', err);
  }

  // Source 3: Static JSON overrides
  if (staticPath) {
    const staticEntries = loadStaticFuzzyTable(staticPath);
    result.staticOverrides = Object.keys(staticEntries).length;
    Object.assign(result.table, staticEntries);
    if (result.staticOverrides > 0) {
      logger.info(`FuzzyBuilder: ${result.staticOverrides} static overrides from ${staticPath}`);
    }
  }

  result.total = Object.keys(result.table).length;
  logger.info(`FuzzyBuilder: total ${result.total} entries (${result.wikiCardEntries} wiki, ${result.sessionLogEntries} logs, ${result.staticOverrides} static)`);

  return result;
}
