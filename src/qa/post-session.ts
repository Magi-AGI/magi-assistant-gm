/**
 * v4: Post-session QA — automated checks and fuzzy table persistence.
 *
 * Runs when the session ends (Discord session stops or silence timeout).
 * 1. Compute transcript metrics (segment count, duration, speaker distribution)
 * 2. Generate advice delivery summary
 * 3. Collect phonetic match discoveries → compute fuzzy table delta
 * 4. Write updated fuzzy table to wiki card
 * 5. Post QA summary to Discord (and Foundry if connected)
 */

import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { McpAggregator } from '../mcp/client.js';
import type { FuzzyMatchTable } from '../reasoning/triggers.js';
import { extractMcpText } from '../reasoning/context.js';
import type { SessionStats } from './session-stats.js';

/** Minimum phonetic similarity to persist a match to the fuzzy table. */
const PERSIST_CONFIDENCE_THRESHOLD = 0.8;

const FUZZY_WIKI_CARD = 'Tools+Magi Assistant GM+Fuzzy Match Table';

interface TranscriptSegment {
  text: string;
  userId?: string;
  displayName?: string;
  speakerLabel?: string;
  timestamp: string;
}

export interface QaReport {
  /** Session duration in minutes. */
  durationMinutes: number;
  /** Total transcript segments. */
  segmentCount: number;
  /** Unique speakers detected. */
  speakerCount: number;
  /** Speaker distribution (name → segment count). */
  speakerDistribution: Record<string, number>;
  /** Advice delivery stats. */
  stats: SessionStats;
  /** Phonetic matches discovered this session. */
  phoneticDiscoveries: Array<{ input: string; canonical: string; similarity: number }>;
  /** New fuzzy table entries written to wiki (input → canonical). */
  fuzzyTableDelta: Record<string, string>;
  /** Whether fuzzy table was successfully persisted to wiki. */
  fuzzyTablePersisted: boolean;
}

/**
 * Run post-session QA.
 */
export async function runPostSessionQa(
  mcp: McpAggregator,
  transcriptCache: TranscriptSegment[],
  stats: SessionStats,
  currentFuzzyTable: FuzzyMatchTable,
  phoneticDiscoveries: Array<{ input: string; canonical: string; similarity: number }>,
): Promise<QaReport> {
  logger.info('PostSessionQA: starting...');

  // -- Transcript metrics --
  // Use real-time accumulated stats (survives ring buffer eviction in long sessions).
  // Duration is still computed from the ring buffer (best available approximation).
  const segmentCount = stats.totalSegmentCount || transcriptCache.length;
  let durationMinutes = 0;
  if (transcriptCache.length >= 2) {
    const first = new Date(transcriptCache[0].timestamp).getTime();
    const last = new Date(transcriptCache[transcriptCache.length - 1].timestamp).getTime();
    durationMinutes = Math.round((last - first) / 60_000);
  }
  // Prefer session start → last segment for duration if available
  if (stats.sessionStartedAt && transcriptCache.length >= 1) {
    const start = new Date(stats.sessionStartedAt).getTime();
    const last = new Date(transcriptCache[transcriptCache.length - 1].timestamp).getTime();
    if (Number.isFinite(start) && Number.isFinite(last)) {
      durationMinutes = Math.round((last - start) / 60_000);
    }
  }

  const speakerDistribution = Object.keys(stats.speakerDistribution).length > 0
    ? stats.speakerDistribution
    : (() => {
        const dist: Record<string, number> = {};
        for (const seg of transcriptCache) {
          const speaker = seg.displayName ?? seg.speakerLabel ?? seg.userId ?? 'unknown';
          dist[speaker] = (dist[speaker] ?? 0) + 1;
        }
        return dist;
      })();
  const speakerCount = Object.keys(speakerDistribution).length;

  // -- Phonetic match delta --
  // Deduplicate, filter by confidence (≥0.8 per v4 plan), exclude existing entries
  const fuzzyTableDelta: Record<string, string> = {};
  const seen = new Set<string>();
  for (const discovery of phoneticDiscoveries) {
    const key = discovery.input.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Only persist high-confidence matches (per v4 plan: "confirmed matches are promoted")
    if (discovery.similarity < PERSIST_CONFIDENCE_THRESHOLD) continue;
    // Only add if not already in the fuzzy table
    if (!currentFuzzyTable[key]) {
      fuzzyTableDelta[key] = discovery.canonical;
    }
  }

  // -- Persist fuzzy table to wiki --
  let fuzzyTablePersisted = false;
  if (Object.keys(fuzzyTableDelta).length > 0 && mcp.isConnected('wiki')) {
    fuzzyTablePersisted = await persistFuzzyTable(mcp, currentFuzzyTable, fuzzyTableDelta);
  }

  const report: QaReport = {
    durationMinutes,
    segmentCount,
    speakerCount,
    speakerDistribution,
    stats,
    phoneticDiscoveries,
    fuzzyTableDelta,
    fuzzyTablePersisted,
  };

  logger.info(
    `PostSessionQA: complete — ${segmentCount} segments, ${durationMinutes} min, ` +
    `${speakerCount} speakers, ${stats.adviceDelivered} advice delivered, ` +
    `${Object.keys(fuzzyTableDelta).length} new fuzzy entries`
  );

  return report;
}

/**
 * Extract HTML content from a wiki get_card MCP result.
 * Handles JSON envelope format: {"id":..., "text":"<html>..."}.
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
    // Not JSON — treat as raw HTML
  }
  return text;
}

/**
 * Persist the fuzzy table delta to the wiki card.
 * Reads the current card HTML, appends new rows to the last HTML table, and updates.
 */
async function persistFuzzyTable(
  mcp: McpAggregator,
  currentTable: FuzzyMatchTable,
  delta: Record<string, string>,
): Promise<boolean> {
  try {
    // Read the current wiki card content (extract HTML from JSON envelope)
    const cardRaw = await mcp.callTool('wiki__get_card', {
      name: FUZZY_WIKI_CARD,
      max_content_length: 0,
    });
    let html = extractCardHtml(cardRaw) ?? '';

    // Build new rows HTML
    const newRows = Object.entries(delta)
      .map(([garble, correct]) => `<tr><td>${escapeHtml(garble)}</td><td>${escapeHtml(correct)}</td></tr>`)
      .join('\n');

    // Insert before the LAST </table> tag (avoids corrupting other tables on the card)
    const lastTableClose = html.lastIndexOf('</table>');
    if (lastTableClose >= 0) {
      html = html.slice(0, lastTableClose) + newRows + '\n' + html.slice(lastTableClose);
    } else {
      // No table exists — create one
      html += `\n<table>\n<tr><th>Garble</th><th>Correct</th></tr>\n${newRows}\n</table>`;
    }

    if (getConfig().dryRun) {
      logger.info(`PostSessionQA: [DRY-RUN] would persist ${Object.keys(delta).length} new entries to wiki fuzzy table`);
      return true;
    }

    await mcp.callTool('wiki__update_card', {
      name: FUZZY_WIKI_CARD,
      content: html,
    });

    logger.info(`PostSessionQA: persisted ${Object.keys(delta).length} new entries to wiki fuzzy table`);
    return true;
  } catch (err) {
    logger.error('PostSessionQA: failed to persist fuzzy table to wiki:', err);
    return false;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format a QA report as a human-readable string for Discord/Foundry posting.
 */
export function formatQaReport(report: QaReport): string {
  const lines: string[] = [];
  lines.push('GM Assistant — Post-Session QA Report');
  lines.push('');

  // Session overview
  lines.push(`Duration: ~${report.durationMinutes} min`);
  lines.push(`Transcript: ${report.segmentCount} segments, ${report.speakerCount} speakers`);

  // Speaker distribution (top 5)
  const speakers = Object.entries(report.speakerDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (speakers.length > 0) {
    const total = report.segmentCount || 1;
    const dist = speakers.map(([name, count]) =>
      `${name}: ${count} (${Math.round(count / total * 100)}%)`
    ).join(', ');
    lines.push(`Speakers: ${dist}`);
  }

  // Advice delivery
  lines.push('');
  lines.push(`Advice Delivered: ${report.stats.adviceDelivered}`);
  if (report.stats.adviceViaFoundry > 0 || report.stats.adviceViaDiscord > 0) {
    lines.push(`  Foundry: ${report.stats.adviceViaFoundry}, Discord: ${report.stats.adviceViaDiscord}`);
  }
  if (report.stats.adviceSuppressed > 0) {
    lines.push(`  Suppressed (dedup/NO_ADVICE): ${report.stats.adviceSuppressed}`);
  }

  // Activation
  if (report.stats.activatedAt) {
    const activatedDelay = report.stats.sessionStartedAt
      ? Math.round((new Date(report.stats.activatedAt).getTime() - new Date(report.stats.sessionStartedAt).getTime()) / 60_000)
      : null;
    lines.push(`Activation: ${report.stats.activationSource ?? 'unknown'}${activatedDelay !== null ? ` (${activatedDelay} min after session start)` : ''}`);
  }

  // Phonetic discoveries
  if (report.phoneticDiscoveries.length > 0) {
    lines.push('');
    lines.push(`Phonetic Discoveries: ${report.phoneticDiscoveries.length}`);
    // Show unique discoveries
    const unique = new Map<string, { canonical: string; similarity: number }>();
    for (const d of report.phoneticDiscoveries) {
      if (!unique.has(d.input)) unique.set(d.input, d);
    }
    for (const [input, d] of unique) {
      lines.push(`  "${input}" -> ${d.canonical} (${d.similarity.toFixed(2)})`);
    }
  }

  // Fuzzy table delta
  if (Object.keys(report.fuzzyTableDelta).length > 0) {
    lines.push('');
    const deltaCount = Object.keys(report.fuzzyTableDelta).length;
    lines.push(`Fuzzy Table: +${deltaCount} new entries ${report.fuzzyTablePersisted ? '(persisted to wiki)' : '(wiki write FAILED)'}`);
  }

  return lines.join('\n');
}
