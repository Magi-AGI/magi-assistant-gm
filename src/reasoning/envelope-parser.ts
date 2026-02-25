/**
 * Pure functions for parsing Claude's JSON advice envelope responses.
 */

import { logger } from '../logger.js';
import type { AdviceEnvelope, AdviceCategory, TriggerPriority } from '../types/index.js';

const VALID_CATEGORIES: ReadonlySet<string> = new Set<AdviceCategory>([
  'script', 'gap-fill', 'pacing', 'continuity', 'spotlight',
  'mechanics', 'technical', 'creative', 'none',
]);

/**
 * Parse a Claude response as a JSON advice envelope.
 * Returns null on parse failure (caller should fall back to wrapFreeTextAsEnvelope).
 */
export function parseAdviceEnvelope(text: string): AdviceEnvelope | null {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);

    // Validate required fields
    if (typeof parsed.category !== 'string' || !VALID_CATEGORIES.has(parsed.category)) {
      logger.warn(`EnvelopeParser: invalid category "${parsed.category}"`);
      return null;
    }
    if (typeof parsed.tag !== 'string' || parsed.tag.length === 0) {
      logger.warn('EnvelopeParser: missing or empty tag');
      return null;
    }
    if (typeof parsed.summary !== 'string') {
      logger.warn('EnvelopeParser: missing summary');
      return null;
    }

    return {
      category: parsed.category as AdviceCategory,
      tag: parsed.tag,
      priority: typeof parsed.priority === 'number' ? parsed.priority as TriggerPriority : 4,
      summary: parsed.summary,
      body: parsed.body ?? null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      source_cards: Array.isArray(parsed.source_cards) ? parsed.source_cards : [],
      image: parsed.image && typeof parsed.image.path === 'string' ? parsed.image : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Wrap free-text Claude response as an advice envelope (fallback for non-JSON responses).
 */
export function wrapFreeTextAsEnvelope(text: string, priority: TriggerPriority): AdviceEnvelope {
  logger.warn('EnvelopeParser: Claude did not return JSON — wrapping as free-text envelope');
  return {
    category: 'creative',
    tag: 'FREETEXT',
    priority,
    summary: text.slice(0, 80),
    body: text,
    confidence: 0.5,
    source_cards: [],
  };
}

/**
 * Check if an envelope is the NO_ADVICE sentinel.
 */
export function isNoAdvice(envelope: AdviceEnvelope): boolean {
  return envelope.category === 'none' && envelope.tag === 'NO_ADVICE';
}
