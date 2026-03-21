/**
 * v4: Wiki discovery bootstrap.
 *
 * Runs Phase 2 of the v4 startup sequence: discovers session plan,
 * builds fuzzy table, extracts NPC links and act structure from the wiki.
 * Returns a DiscoveryReport that feeds into the readiness report.
 */

import { logger } from '../logger.js';
import type { McpAggregator } from '../mcp/client.js';
import type { GmConfig } from '../config.js';
import { extractMcpText } from '../reasoning/context.js';
import { findSessionPlan, findBeatCards, slugify, extractGroupId, type SessionFinderResult } from './session-finder.js';
import { buildFuzzyTable, type FuzzyBuildResult } from './fuzzy-builder.js';
import type { FuzzyMatchTable } from '../reasoning/triggers.js';

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

/** Extract <a href="/..."> link target card paths from HTML. */
function extractWikiLinks(html: string): string[] {
  const links: string[] = [];
  const pattern = /href="\/([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const decoded = decodeURIComponent(match[1]).replace(/_/g, ' ');
    links.push(decoded);
  }
  return [...new Set(links)];
}

/** Extract the display name from a card path (last segment). */
function cardPathToName(cardPath: string): string {
  const segments = cardPath.split('+');
  return segments[segments.length - 1].replace(/_/g, ' ');
}

/** Extract session end time from plan card text. */
function extractSessionEndTime(plainText: string): string | null {
  const patterns = [
    /session\s+end\s*(?:time)?[:\s]+(\d{1,2}:\d{2})/i,
    /end\s+time[:\s]+(\d{1,2}:\d{2})/i,
    /ends?\s+(?:at|by)\s+(\d{1,2}:\d{2})/i,
  ];

  for (const pat of patterns) {
    const match = plainText.match(pat);
    if (match) return match[1];
  }

  return null;
}

export interface DiscoveryReport {
  /** Session plan discovery result (null if not found). */
  sessionPlan: SessionFinderResult | null;
  /** The resolved plan card name (from discovery or override). */
  planCardName: string | null;
  /** Episode reference extracted from the plan. */
  episodeRef: string | null;
  /** NPC wiki card links found in the plan tree. */
  npcLinks: string[];
  /** Session end time extracted from the plan (HH:MM format). */
  sessionEndTime: string | null;
  /** Fuzzy match table build result. */
  fuzzyResult: FuzzyBuildResult;
  /** The merged fuzzy match table. */
  fuzzyTable: FuzzyMatchTable;
  /** Activation dictionary term count (estimate). */
  activationDictSize: number;
  /** v7: Beat card paths discovered for this session. */
  beatCardPaths: string[];
  /** v7: Number of beat cards found. */
  beatCardCount: number;
  /** Warnings accumulated during discovery. */
  warnings: string[];
}

/**
 * Run Phase 2 of the v4 startup sequence: wiki discovery.
 *
 * 1. Find session plan card (tags -> type search -> override)
 * 2. Fetch plan card and extract: episode ref, NPC links, session end time
 * 3. Build fuzzy match table (wiki card + session logs + static JSON)
 * 4. Compute activation dictionary size estimate
 */
export async function runWikiDiscovery(
  mcp: McpAggregator,
  config: GmConfig,
): Promise<DiscoveryReport> {
  const warnings: string[] = [];
  const campaignSlug = slugify(config.campaignName);
  const groupId = extractGroupId(config.campaignGroup);

  logger.info(`WikiDiscovery: starting (campaign:${campaignSlug}, group:${groupId})`);

  // -- Step 1: Find session plan --
  const sessionPlan = await findSessionPlan(
    mcp,
    config.campaignName,
    config.campaignGroup,
    config.campaignWikiCard || undefined,
  );

  if (!sessionPlan) {
    warnings.push('No session plan card found. NPC cache, scene index, and pacing gates will be degraded.');
  } else if (sessionPlan.discrepancy) {
    warnings.push(sessionPlan.discrepancy);
  }

  const planCardName = sessionPlan?.cardName ?? null;

  // -- Step 2: Fetch plan card content --
  let episodeRef: string | null = null;
  let npcLinks: string[] = [];
  let sessionEndTime: string | null = null;

  if (planCardName) {
    try {
      const planRaw = await mcp.callTool('wiki__get_card', {
        name: planCardName,
        max_content_length: 0,
      });
      const planText = extractMcpText(planRaw);
      if (planText) {
        const allLinks = extractWikiLinks(planText);

        // Identify episode reference
        episodeRef = allLinks.find(link => /episode/i.test(link)) ?? null;

        // All links are potential NPC/location references
        npcLinks = allLinks;

        // Extract session end time
        const plainText = stripHtml(planText);
        sessionEndTime = extractSessionEndTime(plainText);

        logger.info(`WikiDiscovery: plan card loaded -- ${allLinks.length} links, episode: ${episodeRef ? cardPathToName(episodeRef) : 'none'}`);
      } else {
        warnings.push(`Session plan card "${planCardName}" exists but is empty.`);
      }
    } catch (err) {
      warnings.push(`Failed to load session plan card "${planCardName}": ${err}`);
      logger.error('WikiDiscovery: failed to load plan card:', err);
    }

    // Also fetch children of the plan card for more links
    try {
      const childrenRaw = await mcp.callTool('wiki__list_children', {
        parent_name: planCardName,
        depth: 2,
        limit: 50,
      });
      const childrenText = extractMcpText(childrenRaw);
      if (childrenText) {
        try {
          const parsed = JSON.parse(childrenText);
          const children: Array<{ id: string }> = Array.isArray(parsed) ? parsed : (parsed?.results ?? []);

          const childFetches = children.map(async (child) => {
            try {
              const childRaw = await mcp.callTool('wiki__get_card', {
                name: child.id,
                max_content_length: 8000,
              });
              const childText = extractMcpText(childRaw);
              if (childText) {
                npcLinks.push(...extractWikiLinks(childText));
              }
            } catch { /* skip failed children */ }
          });
          await Promise.allSettled(childFetches);
        } catch { /* invalid JSON */ }
      }
    } catch {
      logger.debug('WikiDiscovery: failed to list plan children');
    }

    // Deduplicate and remove self-reference
    npcLinks = [...new Set(npcLinks)].filter(link => link !== planCardName);
  }

  // -- Step 3: Build fuzzy match table (parallel with step 2 children fetch is fine) --
  const fuzzyResult = await buildFuzzyTable(
    mcp,
    campaignSlug,
    config.sttFuzzyMatchPath || undefined,
  );

  if (fuzzyResult.total === 0) {
    warnings.push('Fuzzy match table is empty. Auto-ACTIVE detection may not trigger reliably.');
  }

  // -- Step 4: v7 — Find beat cards for this session --
  const sessionNumber = sessionPlan?.sessionNumber ?? 0;
  const beatCardResult = await findBeatCards(mcp, sessionNumber, planCardName, config.campaignName);
  const beatCardPaths = beatCardResult.cards;
  if (beatCardPaths.length > 0) {
    logger.info(`WikiDiscovery: found ${beatCardPaths.length} beat cards for session ${sessionNumber} (via ${beatCardResult.discoveryMethod})`);
  } else if (sessionNumber > 0) {
    warnings.push(`No beat cards found for session ${sessionNumber}. Beat reminders and whisper staging will be unavailable.`);
  }

  // -- Step 5: Estimate activation dictionary size --
  const activationTerms = new Set<string>();
  for (const [garbled, canonical] of Object.entries(fuzzyResult.table)) {
    activationTerms.add(garbled);
    activationTerms.add(canonical);
  }
  for (const link of npcLinks) {
    const name = cardPathToName(link).toLowerCase();
    if (name.length >= 4) activationTerms.add(name);
  }
  const activationDictSize = activationTerms.size;

  if (activationDictSize < 30) {
    warnings.push(`Low activation dictionary coverage (${activationDictSize} terms). Auto-ACTIVE may not trigger reliably.`);
  }

  logger.info(
    `WikiDiscovery: complete -- plan: ${planCardName ?? 'NONE'}, ` +
    `beat cards: ${beatCardPaths.length}, ` +
    `fuzzy: ${fuzzyResult.total} terms, activation: ~${activationDictSize} terms, ` +
    `warnings: ${warnings.length}`
  );

  return {
    sessionPlan,
    planCardName,
    episodeRef,
    npcLinks,
    sessionEndTime,
    fuzzyResult,
    fuzzyTable: fuzzyResult.table,
    activationDictSize,
    beatCardPaths,
    beatCardCount: beatCardPaths.length,
    warnings,
  };
}

/**
 * Format a readiness report for logging.
 * Returns a multi-line string suitable for console or Discord.
 */
export function formatReadinessReport(report: DiscoveryReport, config: GmConfig): string {
  const lines: string[] = [];
  lines.push('GM Assistant v4 — Readiness Report');
  lines.push('');

  // Session plan
  if (report.sessionPlan) {
    const method = report.sessionPlan.discoveryMethod;
    const name = cardPathToName(report.sessionPlan.cardName);
    lines.push(`Session Plan: ${name} (session ${report.sessionPlan.sessionNumber}, via ${method})`);
  } else {
    lines.push('Session Plan: NOT FOUND');
  }

  // Episode
  if (report.episodeRef) {
    lines.push(`Episode: ${cardPathToName(report.episodeRef)}`);
  }

  // NPC links
  lines.push(`NPC/Content Links: ${report.npcLinks.length} found`);

  // v7: Beat cards
  if (report.beatCardCount > 0) {
    lines.push(`Beat Cards: ${report.beatCardCount} found`);
  } else {
    lines.push('Beat Cards: NONE — beat reminders unavailable');
  }

  // Fuzzy table
  const f = report.fuzzyResult;
  lines.push(`Fuzzy Table: ${f.total} terms (${f.wikiCardEntries} wiki, ${f.sessionLogEntries} from ${f.sessionLogCount} logs, ${f.staticOverrides} static)`);

  // Activation dictionary
  lines.push(`Activation Dict: ~${report.activationDictSize} terms`);

  // Session end time
  if (report.sessionEndTime) {
    lines.push(`Session End Time: ${report.sessionEndTime} (from plan card)`);
  } else if (config.sessionEndTime) {
    lines.push(`Session End Time: ${config.sessionEndTime} (from .env)`);
  } else {
    lines.push('Session End Time: NOT SET — pacing gates disabled');
  }

  // Warnings
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(`Warnings (${report.warnings.length}):`);
    for (const w of report.warnings) {
      lines.push(`  - ${w}`);
    }
  }

  return lines.join('\n');
}
