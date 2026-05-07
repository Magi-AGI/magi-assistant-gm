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

/**
 * QA #36 + Pattern 40: per-speaker statistics derived from the full session
 * window via discord__get_session_timeline (including interim emissions).
 *
 * Three metrics are surfaced because they answer different questions:
 * - segmentsAll: every transcript_segments row (interim + final). Diagnostic
 *   for the STT pipeline; inflates speakers whose phrasing causes more refines.
 * - segmentsFinal: only is_final=1 rows. Diagnostic for what was actually said.
 * - speakingMs: final-only, weighted by segment_end - segment_start. The
 *   airtime metric trustworthy for spotlight analysis.
 */
export interface SpeakerStat {
  segmentsAll: number;
  segmentsFinal: number;
  speakingMs: number;
}

interface TimelineTranscriptRow {
  type: 'transcript';
  timestamp: string;
  segmentEnd?: string | null;
  userId: string | null;
  displayName: string | null;
  content: string | null;
  isFinal?: boolean;
}

interface TimelineTextRow {
  type: 'text';
  timestamp: string;
  userId: string | null;
  displayName: string | null;
  content: string | null;
}

type TimelineRow = TimelineTranscriptRow | TimelineTextRow;

export interface QaReport {
  /** Session duration in minutes. */
  durationMinutes: number;
  /** Total transcript segments. */
  segmentCount: number;
  /** Unique speakers detected. */
  speakerCount: number;
  /**
   * Speaker distribution (name → segment count, all segments inc. interim).
   * Kept for backwards compatibility with existing report consumers.
   */
  speakerDistribution: Record<string, number>;
  /**
   * QA #36: full per-speaker stats from a session-end MCP query against the
   * discord transcript store. Speaker list is the union across the full
   * session window (no end-of-session filter), so early leavers are
   * preserved. Falls back to undefined if the discord MCP call fails or the
   * server-side includeInterim flag isn't yet deployed.
   */
  speakerStats?: Record<string, SpeakerStat>;
  /**
   * QA #36: which source produced speakerStats / speakerDistribution.
   * 'mcp_timeline' = full-session discord query (preferred, post-#36).
   * 'realtime_stats' = legacy in-memory accumulator (current behavior;
   *                    inflated by interim emissions, drops early leavers).
   * 'transcript_cache' = ring-buffer fallback (last-resort).
   */
  speakerStatsSource?: 'mcp_timeline' | 'realtime_stats' | 'transcript_cache';
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
 * QA #36 + Pattern 40: derive per-speaker stats from a discord timeline
 * payload (must be queried with includeInterim=true to see all-segments).
 *
 * Pure function over a parsed payload — exported for the regression suite.
 * Speaker key = displayName ?? userId ?? 'unknown'. Time-weighted speakingMs
 * is computed only from final rows that carry both timestamp and segmentEnd
 * (older rows with null segment_end contribute 0 ms — flagged in logs).
 */
export function computeSpeakerStats(timeline: readonly TimelineRow[]): Record<string, SpeakerStat> {
  const stats: Record<string, SpeakerStat> = {};
  for (const row of timeline) {
    if (row.type !== 'transcript') continue;
    const speaker = row.displayName ?? row.userId ?? 'unknown';
    const slot = stats[speaker] ?? (stats[speaker] = { segmentsAll: 0, segmentsFinal: 0, speakingMs: 0 });
    slot.segmentsAll++;
    if (row.isFinal) {
      slot.segmentsFinal++;
      if (row.segmentEnd && row.timestamp) {
        const start = Date.parse(row.timestamp);
        const end = Date.parse(row.segmentEnd);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          slot.speakingMs += end - start;
        }
      }
    }
  }
  return stats;
}

/**
 * QA #36: query discord__get_session_timeline for a full-session view.
 * Returns null on failure so the caller can fall back to in-memory state.
 */
async function fetchTimeline(mcp: McpAggregator, sessionId: string): Promise<TimelineRow[] | null> {
  if (!mcp.isConnected('discord')) {
    logger.warn('PostSessionQA: discord MCP not connected — falling back to in-memory speaker stats');
    return null;
  }
  try {
    const raw = await mcp.callTool('discord__get_session_timeline', {
      sessionId,
      includeInterim: true,
    });
    const text = extractMcpText(raw);
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed as TimelineRow[];
  } catch (err) {
    logger.warn('PostSessionQA: discord__get_session_timeline failed:', err);
    return null;
  }
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
  sessionId?: string,
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

  // QA #36 + Pattern 40: prefer a full-session MCP query so early leavers
  // appear and we can surface segment-count (all + final-only) and a
  // time-weighted speaking metric. Fall back to the in-memory accumulator if
  // discord MCP is unavailable or the timeline payload is empty.
  let speakerStats: Record<string, SpeakerStat> | undefined;
  let speakerStatsSource: QaReport['speakerStatsSource'];
  let speakerDistribution: Record<string, number>;

  if (sessionId) {
    const timeline = await fetchTimeline(mcp, sessionId);
    if (timeline && timeline.length > 0) {
      speakerStats = computeSpeakerStats(timeline);
      speakerStatsSource = 'mcp_timeline';
    }
  }

  if (speakerStats) {
    speakerDistribution = Object.fromEntries(
      Object.entries(speakerStats).map(([name, s]) => [name, s.segmentsAll]),
    );
  } else if (Object.keys(stats.speakerDistribution).length > 0) {
    speakerDistribution = stats.speakerDistribution;
    speakerStatsSource = 'realtime_stats';
  } else {
    speakerDistribution = {};
    for (const seg of transcriptCache) {
      const speaker = seg.displayName ?? seg.speakerLabel ?? seg.userId ?? 'unknown';
      speakerDistribution[speaker] = (speakerDistribution[speaker] ?? 0) + 1;
    }
    speakerStatsSource = 'transcript_cache';
  }

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
    speakerStats,
    speakerStatsSource,
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

  // Speaker distribution. With QA #36 + Pattern 40 we have three metrics
  // (segment-count all, segment-count final-only, time-weighted final-only)
  // and surface them side-by-side. Sorted by all-segments share, top 8 — long
  // sessions sometimes have early leavers worth showing.
  const SPEAKER_LIMIT = 8;
  if (report.speakerStats) {
    const totalAll = Object.values(report.speakerStats).reduce((a, s) => a + s.segmentsAll, 0) || 1;
    const totalFinal = Object.values(report.speakerStats).reduce((a, s) => a + s.segmentsFinal, 0) || 1;
    const totalMs = Object.values(report.speakerStats).reduce((a, s) => a + s.speakingMs, 0) || 1;
    const sorted = Object.entries(report.speakerStats).sort((a, b) => b[1].segmentsAll - a[1].segmentsAll);
    const sourceLabel = report.speakerStatsSource === 'mcp_timeline' ? '' : ` (source: ${report.speakerStatsSource})`;
    lines.push(`Speakers (all-seg / final-only / airtime)${sourceLabel}:`);
    for (const [name, s] of sorted.slice(0, SPEAKER_LIMIT)) {
      const allPct = Math.round((s.segmentsAll / totalAll) * 100);
      const finalPct = Math.round((s.segmentsFinal / totalFinal) * 100);
      const airtimePct = Math.round((s.speakingMs / totalMs) * 100);
      lines.push(`  ${name}: ${allPct}% / ${finalPct}% / ${airtimePct}% (${s.segmentsFinal} final, ${Math.round(s.speakingMs / 1000)}s)`);
    }
    if (sorted.length > SPEAKER_LIMIT) {
      lines.push(`  … +${sorted.length - SPEAKER_LIMIT} more`);
    }
  } else {
    // Legacy single-metric rendering when speakerStats is unavailable.
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
  }

  // Advice delivery
  lines.push('');
  lines.push(`Advice Delivered: ${report.stats.adviceDelivered}`);
  if (report.stats.adviceViaFoundry > 0 || report.stats.adviceViaDiscord > 0) {
    lines.push(`  Foundry: ${report.stats.adviceViaFoundry}, Discord: ${report.stats.adviceViaDiscord}`);
  }
  if (report.stats.adviceSuppressed > 0) {
    const total = report.stats.adviceDelivered + report.stats.adviceSuppressed;
    const pct = total > 0 ? Math.round((report.stats.adviceSuppressed / total) * 100) : 0;
    lines.push(`  Suppressed: ${report.stats.adviceSuppressed} (${pct}% of candidates)`);
    const bins = report.stats.suppressedByReason;
    const binParts: string[] = [];
    if (bins.already_covered > 0) binParts.push(`already-covered: ${bins.already_covered}`);
    if (bins.below_confidence > 0) binParts.push(`below-confidence: ${bins.below_confidence}`);
    if (bins.timing_window > 0) binParts.push(`timing-window: ${bins.timing_window}`);
    if (bins.duplicate > 0) binParts.push(`duplicate: ${bins.duplicate}`);
    if (binParts.length > 0) lines.push(`    ${binParts.join(', ')}`);

    // QA #35: surface up to 8 sampled suppressions (with the reservoir already
    // uniformly sampled across the session) so a human can sanity-check the
    // per-candidate decisions instead of trusting bin totals alone.
    const SAMPLE_LIMIT = 8;
    const samples = report.stats.suppressedSamples.slice(0, SAMPLE_LIMIT);
    if (samples.length > 0) {
      lines.push('  Sampled suppressions:');
      for (const s of samples) {
        const ts = s.timestamp.slice(11, 16); // HH:MM
        const events = s.eventTypes.join('+');
        const advice = s.adviceTag ? ` [${s.adviceTag}]` : '';
        const adviceSnippet = s.adviceText ? ` "${s.adviceText.slice(0, 60).replace(/\s+/g, ' ')}"` : '';
        const gates = s.gateValues
          ? ' ' + Object.entries(s.gateValues).map(([k, v]) => `${k}=${v}`).join(',')
          : '';
        lines.push(`    ${ts} P${s.priority} ${s.reason} (${events})${advice}${adviceSnippet}${gates}`);
      }
      if (report.stats.suppressedSamples.length > SAMPLE_LIMIT) {
        lines.push(`    … ${report.stats.suppressedSamples.length - SAMPLE_LIMIT} more sampled (full set in stats)`);
      }
    }
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
