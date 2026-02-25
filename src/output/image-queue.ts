/**
 * Single-slot image suggestion queue with 2-minute TTL.
 * The GM confirms or rejects via /yes or /no in Discord.
 */

import { logger } from '../logger.js';
import type { ImageSuggestion } from '../types/index.js';

const DEFAULT_TTL_MS = 2 * 60_000; // 2 minutes

export interface PendingImage {
  suggestion: ImageSuggestion;
  enqueuedAt: number;
  ttlMs: number;
}

export class ImageQueue {
  private pending: PendingImage | null = null;

  /** Queue an image suggestion. Replaces any existing pending suggestion. */
  setPending(suggestion: ImageSuggestion, ttlMs = DEFAULT_TTL_MS): void {
    if (this.pending) {
      logger.info('ImageQueue: replacing existing pending image');
    }
    this.pending = {
      suggestion,
      enqueuedAt: Date.now(),
      ttlMs,
    };
    logger.info(`ImageQueue: queued image "${suggestion.path}" (TTL: ${ttlMs / 1000}s)`);
  }

  /** Get the current pending image, or null if expired/empty. */
  getPending(): PendingImage | null {
    if (!this.pending) return null;

    // Check TTL
    const age = Date.now() - this.pending.enqueuedAt;
    if (age > this.pending.ttlMs) {
      logger.info('ImageQueue: pending image expired (TTL exceeded)');
      this.pending = null;
      return null;
    }

    return this.pending;
  }

  /** Confirm the pending image (returns the suggestion and clears the slot). */
  confirm(): ImageSuggestion | null {
    const current = this.getPending();
    if (!current) {
      logger.warn('ImageQueue: confirm called but no pending image');
      return null;
    }
    const suggestion = current.suggestion;
    this.pending = null;
    logger.info(`ImageQueue: confirmed image "${suggestion.path}"`);
    return suggestion;
  }

  /** Reject the pending image (clears the slot silently). */
  reject(): void {
    if (this.pending) {
      logger.info(`ImageQueue: rejected image "${this.pending.suggestion.path}"`);
    }
    this.pending = null;
  }

  /** Check if there's a pending (non-expired) image. */
  hasPending(): boolean {
    return this.getPending() !== null;
  }
}
