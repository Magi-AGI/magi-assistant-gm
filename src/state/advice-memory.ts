import { AdviceMemoryEntry, AdviceCategory, AdviceEnvelope, AdviceMemory } from '../types/index.js';

/** Normalize summary for dedup: lowercase, trim, strip numbers (e.g. "12 min" vs "13 min"). */
function normalizeSummary(summary: string): string {
  return summary.toLowerCase().trim().replace(/\d+/g, '#');
}

/**
 * Rolling buffer of the last N advice messages.
 * Used for dedup checking and injecting [ALREADY ADVISED] into context.
 */
export class AdviceMemoryBuffer {
  private _entries: AdviceMemoryEntry[] = [];
  private _maxSize: number;

  constructor(maxSize = 5) {
    this._maxSize = maxSize;
  }

  get entries(): readonly AdviceMemoryEntry[] { return this._entries; }
  get size(): number { return this._entries.length; }

  /** Push a delivered advice envelope into memory. Evicts oldest if at capacity. */
  push(envelope: AdviceEnvelope): void {
    const entry: AdviceMemoryEntry = {
      timestamp: new Date().toISOString(),
      category: envelope.category,
      tag: envelope.tag,
      summary: envelope.summary,
      full_text: envelope.body ?? '',
    };

    this._entries.push(entry);

    // Evict oldest if over capacity
    while (this._entries.length > this._maxSize) {
      this._entries.shift();
    }
  }

  /**
   * Check if a new envelope is a duplicate of a recent one.
   * A duplicate requires BOTH the same tag AND a similar summary,
   * OR an exact summary match regardless of tag.
   * Fix #8: tag-only match was too aggressive — the same tag (e.g. PACING)
   * can legitimately carry different advice across scenes.
   */
  isDuplicate(envelope: AdviceEnvelope): boolean {
    const candidateTag = envelope.tag.toUpperCase();
    const candidateSummary = normalizeSummary(envelope.summary);

    return this._entries.some(entry => {
      const entryTag = entry.tag.toUpperCase();
      const entrySummary = normalizeSummary(entry.summary);
      // Same tag AND similar summary = duplicate
      if (entryTag === candidateTag && entrySummary === candidateSummary) return true;
      // Exact normalized summary match (regardless of tag) = duplicate
      if (entrySummary === candidateSummary) return true;
      return false;
    });
  }

  /** Format entries for injection into context as [ALREADY ADVISED] block. */
  formatForContext(): string {
    if (this._entries.length === 0) return '';
    const lines = this._entries.map(e =>
      `- [${e.tag}] ${e.summary} (${e.category}, ${e.timestamp})`
    );
    return `[ALREADY ADVISED]\n${lines.join('\n')}`;
  }

  /** Export as serializable AdviceMemory object. */
  toJSON(): AdviceMemory {
    return {
      entries: [...this._entries],
      max_size: this._maxSize,
    };
  }

  /** Clear all entries (e.g. on session reset). */
  clear(): void {
    this._entries = [];
  }
}
