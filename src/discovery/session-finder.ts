/**
 * v4: Session plan discovery.
 *
 * Finds the current session plan card from the wiki using type + tag search.
 * Primary: search_by_tags with campaign/group/status tags.
 * Fallback: search_cards with BG_SessionPlan type.
 * Override: CAMPAIGN_WIKI_CARD .env variable takes precedence.
 */

import { logger } from '../logger.js';
import type { McpAggregator } from '../mcp/client.js';
import { extractMcpText } from '../reasoning/context.js';

interface SearchResult {
  id: string;
  title: string;
}

/** Normalize a name to a tag slug: "Domino's Fall" -> "dominos-fall" */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Extract group identifier: "Group 1" -> "1", "2" -> "2" */
export function extractGroupId(group: string): string {
  const match = group.match(/(\d+)\s*$/);
  if (match) return match[1];
  return slugify(group);
}

/** Parse search results from an MCP tool call response. */
function parseSearchResults(raw: unknown): SearchResult[] {
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

/** Extract session number from a card title or id. */
function extractSessionNumber(card: SearchResult): number {
  const titleMatch = card.title.match(/session\s+(\d+)/i);
  if (titleMatch) return parseInt(titleMatch[1], 10);

  const idMatch = card.id.match(/session[_\s]+(\d+)/i);
  if (idMatch) return parseInt(idMatch[1], 10);

  return 0;
}

export interface BeatCardSearchResult {
  /** Wiki card paths for discovered beat/scene cards. */
  cards: string[];
  sessionNumber: number;
  discoveryMethod: 'plan-children' | 'name-search' | 'none';
}

export interface SessionFinderResult {
  /** The wiki card name (path) of the session plan. */
  cardName: string;
  /** How the card was found. */
  discoveryMethod: 'tags' | 'type-search' | 'override';
  /** Session number extracted from the card. */
  sessionNumber: number;
  /** If override was used but discovery found a different card. */
  discrepancy?: string;
}

/**
 * Find the current session plan card from the wiki.
 *
 * Search strategy:
 * 1. Search by tags: campaign:{slug}, group:{id} — prefer status:ready
 * 2. Fallback: search by type BG_SessionPlan with campaign name in query
 * 3. Override: CAMPAIGN_WIKI_CARD .env takes precedence if set
 *
 * Selects the highest session number with status:ready preferred.
 */
export async function findSessionPlan(
  mcp: McpAggregator,
  campaignName: string,
  campaignGroup: string,
  overrideCard?: string,
): Promise<SessionFinderResult | null> {
  const campaignSlug = slugify(campaignName);
  const groupId = extractGroupId(campaignGroup);

  logger.info(`SessionFinder: searching (campaign:${campaignSlug}, group:${groupId})`);

  // Strategy 1: Search by tags (most precise)
  let tagResults: SearchResult[] = [];
  try {
    // Try with status:ready first
    const readyRaw = await mcp.callTool('wiki__search_by_tags', {
      tags: [`campaign:${campaignSlug}`, `group:${groupId}`, 'status:ready'],
      match_mode: 'all',
      limit: 10,
    });
    tagResults = parseSearchResults(readyRaw);

    if (tagResults.length === 0) {
      // Fall back to any status for this campaign+group
      const anyRaw = await mcp.callTool('wiki__search_by_tags', {
        tags: [`campaign:${campaignSlug}`, `group:${groupId}`],
        match_mode: 'all',
        limit: 20,
      });
      tagResults = parseSearchResults(anyRaw);
    }
  } catch (err) {
    logger.warn('SessionFinder: tag search failed:', err);
  }

  // Filter to plan cards (by title pattern)
  const planCards = tagResults.filter(r =>
    /session\s+\d+\s+plan/i.test(r.title) || /session\s+\d+\s+plan/i.test(r.id)
  );

  // Strategy 2: Fallback -- search by type
  let typeResults: SearchResult[] = [];
  if (planCards.length === 0) {
    try {
      const typeRaw = await mcp.callTool('wiki__search_cards', {
        query: campaignName,
        type: 'BG_SessionPlan',
        search_in: 'name',
        limit: 20,
      });
      typeResults = parseSearchResults(typeRaw);

      // Filter by group
      const groupPattern = new RegExp(`group[_\\s]*${groupId}`, 'i');
      typeResults = typeResults.filter(r =>
        groupPattern.test(r.id) || groupPattern.test(r.title)
      );
    } catch (err) {
      logger.warn('SessionFinder: type search failed:', err);
    }
  }

  // Combine and pick best candidate
  const allCandidates = planCards.length > 0 ? planCards : typeResults;

  if (allCandidates.length === 0 && !overrideCard) {
    logger.warn('SessionFinder: no session plan cards found');
    return null;
  }

  // Select highest session number
  let discovered: SessionFinderResult | null = null;
  if (allCandidates.length > 0) {
    const sorted = allCandidates
      .map(c => ({ ...c, sessionNum: extractSessionNumber(c) }))
      .sort((a, b) => b.sessionNum - a.sessionNum);

    const best = sorted[0];
    discovered = {
      cardName: best.id,
      discoveryMethod: planCards.length > 0 ? 'tags' : 'type-search',
      sessionNumber: best.sessionNum,
    };

    logger.info(`SessionFinder: discovered "${best.id}" (session ${best.sessionNum}, via ${discovered.discoveryMethod})`);
  }

  // Handle override
  if (overrideCard) {
    const result: SessionFinderResult = {
      cardName: overrideCard,
      discoveryMethod: 'override',
      sessionNumber: discovered?.sessionNumber ?? 0,
    };

    if (discovered && discovered.cardName !== overrideCard) {
      result.discrepancy = `Override: .env says "${overrideCard}", wiki discovery found "${discovered.cardName}". Using override.`;
      logger.warn(`SessionFinder: ${result.discrepancy}`);
    }

    return result;
  }

  return discovered;
}

/**
 * v7: Find scene beat cards for a session, even without a BG_SessionPlan.
 *
 * Strategy 1: If planCardName exists, list_children and filter for scene/beat cards.
 * Strategy 2: search_cards with "Session_{N}_Scene" name pattern.
 *
 * Returns card paths sorted by title (preserving scene order).
 */
export async function findBeatCards(
  mcp: McpAggregator,
  sessionNumber: number,
  planCardName: string | null,
  campaignName: string,
): Promise<BeatCardSearchResult> {
  if (!sessionNumber || sessionNumber <= 0) {
    return { cards: [], sessionNumber: 0, discoveryMethod: 'none' };
  }

  const beatCardPattern = /(?:scene|beat|gm.?notes)/i;

  // Strategy 1: Children of the plan card
  if (planCardName) {
    try {
      const childrenRaw = await mcp.callTool('wiki__list_children', {
        parent_name: planCardName,
        depth: 2,
        limit: 50,
      });
      const childrenText = extractMcpText(childrenRaw);
      if (childrenText) {
        const parsed = JSON.parse(childrenText);
        const children: SearchResult[] = (Array.isArray(parsed) ? parsed : (parsed?.results ?? []))
          .map((r: Record<string, unknown>) => ({
            id: String(r.id ?? ''),
            title: String(r.title ?? r.id ?? ''),
          }));

        const beatCards = children
          .filter(c => beatCardPattern.test(c.title) || beatCardPattern.test(c.id))
          .map(c => c.id)
          .sort();

        if (beatCards.length > 0) {
          logger.info(`SessionFinder: found ${beatCards.length} beat cards via plan children`);
          return { cards: beatCards, sessionNumber, discoveryMethod: 'plan-children' };
        }
      }
    } catch (err) {
      logger.debug('SessionFinder: plan children search for beat cards failed:', err);
    }
  }

  // Strategy 2: Name-based search
  try {
    const query = `Session_${sessionNumber}_Scene`;
    const searchRaw = await mcp.callTool('wiki__search_cards', {
      query,
      search_in: 'name',
      limit: 30,
    });
    const results = parseSearchResults(searchRaw);

    // Filter by campaign name in path
    const campaignSlug = slugify(campaignName);
    const beatCards = results
      .filter(r => {
        const idSlug = slugify(r.id);
        return idSlug.includes(campaignSlug);
      })
      .map(r => r.id)
      .sort();

    if (beatCards.length > 0) {
      logger.info(`SessionFinder: found ${beatCards.length} beat cards via name search ("${query}")`);
      return { cards: beatCards, sessionNumber, discoveryMethod: 'name-search' };
    }
  } catch (err) {
    logger.debug('SessionFinder: name search for beat cards failed:', err);
  }

  // Also try with space instead of underscore
  try {
    const query = `Session ${sessionNumber} Scene`;
    const searchRaw = await mcp.callTool('wiki__search_cards', {
      query,
      search_in: 'name',
      limit: 30,
    });
    const results = parseSearchResults(searchRaw);

    const campaignSlug = slugify(campaignName);
    const beatCards = results
      .filter(r => slugify(r.id).includes(campaignSlug))
      .map(r => r.id)
      .sort();

    if (beatCards.length > 0) {
      logger.info(`SessionFinder: found ${beatCards.length} beat cards via name search (space variant)`);
      return { cards: beatCards, sessionNumber, discoveryMethod: 'name-search' };
    }
  } catch (err) {
    logger.debug('SessionFinder: space variant name search failed:', err);
  }

  logger.info('SessionFinder: no beat cards found');
  return { cards: [], sessionNumber, discoveryMethod: 'none' };
}
