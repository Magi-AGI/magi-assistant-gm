/**
 * v4: Phonetic matching — Layer 3 of the matching pipeline.
 *
 * Uses Double Metaphone encoding + Jaro-Winkler similarity from talisman
 * to detect near-miss STT garbles that aren't in the fuzzy table.
 *
 * Pipeline: exact match → fuzzy table → phonetic similarity (this module).
 */

import doubleMetaphone from 'talisman/phonetics/double-metaphone.js';
import { similarity as jaroWinkler } from 'talisman/metrics/jaro-winkler.js';
import { logger } from '../logger.js';

export interface PhoneticEntry {
  /** The canonical term (lowercase). */
  canonical: string;
  /** Double Metaphone primary code. */
  code1: string;
  /** Double Metaphone secondary code. */
  code2: string;
}

export interface PhoneticMatch {
  /** The input word that matched. */
  input: string;
  /** The canonical term it matched against. */
  canonical: string;
  /** Jaro-Winkler similarity score (0-1). */
  similarity: number;
  /** Whether the match was via metaphone code or Jaro-Winkler string similarity. */
  matchType: 'metaphone' | 'jaro-winkler';
}

/**
 * Levenshtein distance between two strings.
 * Used for comparing metaphone codes (short strings, no need for a library).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[a.length][b.length];
}

/** Estimate syllable count from a word (rough heuristic). */
function estimateSyllables(word: string): number {
  const vowelGroups = word.toLowerCase().match(/[aeiouy]+/g);
  if (!vowelGroups) return 1;
  let count = vowelGroups.length;
  // Trailing silent "e"
  if (word.length > 2 && word.toLowerCase().endsWith('e')) count--;
  return Math.max(1, count);
}

/**
 * Pre-compiled phonetic dictionary for fast matching.
 * Built once from the activation dictionary terms at startup.
 */
export class PhoneticMatcher {
  private entries: PhoneticEntry[] = [];

  /**
   * Build the phonetic index from a set of canonical terms.
   * @param terms — Set of canonical lowercase terms to index.
   */
  constructor(terms: Iterable<string>) {
    for (const term of terms) {
      if (term.length < 3) continue;
      const [code1, code2] = doubleMetaphone(term);
      this.entries.push({ canonical: term, code1, code2 });
    }
    if (this.entries.length > 0) {
      logger.info(`PhoneticMatcher: indexed ${this.entries.length} terms`);
    }
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Add additional terms to the index (e.g., NPC names loaded after initial build).
   * Skips terms already indexed.
   */
  addTerms(terms: Iterable<string>): number {
    const existing = new Set(this.entries.map(e => e.canonical));
    let added = 0;
    for (const term of terms) {
      if (term.length < 3 || existing.has(term)) continue;
      const [code1, code2] = doubleMetaphone(term);
      this.entries.push({ canonical: term, code1, code2 });
      existing.add(term);
      added++;
    }
    if (added > 0) {
      logger.info(`PhoneticMatcher: added ${added} terms (total: ${this.entries.length})`);
    }
    return added;
  }

  /**
   * Find the best phonetic match for a word against the indexed terms.
   *
   * Matching strategy (per v4 plan):
   * 1. Double Metaphone: if edit distance between metaphone codes is ≤2, candidate match.
   * 2. Jaro-Winkler: if string similarity ≥ threshold, candidate match.
   * Returns the best candidate above threshold, or null.
   *
   * @param word — The unrecognized word to match (lowercase).
   * @param threshold — Minimum Jaro-Winkler similarity (default 0.6 for activation, 0.8 for NPC).
   */
  match(word: string, threshold = 0.6): PhoneticMatch | null {
    if (word.length < 3 || this.entries.length === 0) return null;

    // Skip words that are too common / short to be proper nouns
    if (estimateSyllables(word) < 2) return null;

    const [inputCode1, inputCode2] = doubleMetaphone(word);

    let bestMatch: PhoneticMatch | null = null;
    let bestScore = 0;

    for (const entry of this.entries) {
      // Strategy 1: Metaphone code distance
      const dist1 = levenshtein(inputCode1, entry.code1);
      const dist2 = levenshtein(inputCode2, entry.code2);
      const minDist = Math.min(dist1, dist2);

      if (minDist <= 2) {
        // Metaphone match — compute Jaro-Winkler as confidence score
        const sim = jaroWinkler(word, entry.canonical);
        if (sim >= threshold && sim > bestScore) {
          bestScore = sim;
          bestMatch = {
            input: word,
            canonical: entry.canonical,
            similarity: sim,
            matchType: 'metaphone',
          };
        }
        continue;
      }

      // Strategy 2: Jaro-Winkler string similarity (catches non-phonetic near-misses)
      const sim = jaroWinkler(word, entry.canonical);
      if (sim >= threshold && sim > bestScore) {
        bestScore = sim;
        bestMatch = {
          input: word,
          canonical: entry.canonical,
          similarity: sim,
          matchType: 'jaro-winkler',
        };
      }
    }

    return bestMatch;
  }

  /**
   * Extract candidate words from a text segment and match each against the index.
   * Returns all matches above the threshold.
   *
   * Only tests words that are ≥2 syllables and ≥4 characters (likely proper nouns).
   */
  matchSegment(text: string, threshold = 0.6): PhoneticMatch[] {
    const matches: PhoneticMatch[] = [];
    // Extract words: split on whitespace/punctuation but keep apostrophes/hyphens within words
    const words = text.toLowerCase()
      .split(/[\s,;:!?.()[\]{}""]+/)
      .map(w => w.replace(/^['\-]+|['\-]+$/g, ''))  // trim leading/trailing punctuation
      .filter(w => w.length >= 4 && /[a-z]/.test(w));

    for (const word of words) {
      const result = this.match(word, threshold);
      if (result) {
        // Avoid duplicate canonical matches from the same segment
        if (!matches.some(m => m.canonical === result.canonical)) {
          matches.push(result);
        }
      }
    }

    return matches;
  }
}
