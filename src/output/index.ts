/**
 * v4 Advice delivery orchestrator — Foundry-first with tagged Discord fallback.
 *
 * Delivery strategy (per v4 plan Decision 4):
 * 1. Try Foundry whisper first (preferred channel).
 * 2. If Foundry fails: fall back to Discord with [VIA DISCORD] prefix.
 * 3. On first Foundry failure: post warning to Discord.
 * 4. Periodic reminder every 30 minutes while Foundry is down (event-driven:
 *    reminders fire on advice delivery attempts, not a wall-clock timer).
 * 5. On Foundry reconnection: post recovery notice to Discord.
 */

import { logger } from '../logger.js';
import { FoundryAdviceOutput } from './foundry-sidebar.js';
import { DiscordChannelOutput } from './discord-channel.js';
import type { McpAggregator } from '../mcp/client.js';
import type { AdviceEnvelope } from '../types/index.js';

const FOUNDRY_WARNING_INTERVAL_MS = 30 * 60_000; // 30 minutes

export class AdviceDelivery {
  private foundry: FoundryAdviceOutput;
  private discord: DiscordChannelOutput;
  private foundryAvailable = true;
  private lastFoundryWarningTime = 0;

  constructor(mcp: McpAggregator) {
    this.foundry = new FoundryAdviceOutput(mcp);
    this.discord = new DiscordChannelOutput();
  }

  /**
   * Deliver an advice envelope.
   * Tries Foundry first; falls back to Discord with [VIA DISCORD] tag on failure.
   * Returns the channel used: 'foundry', 'discord', or 'none'.
   */
  async deliver(envelope: AdviceEnvelope): Promise<'foundry' | 'discord' | 'none'> {
    // Log advice body (truncated) at INFO level
    const bodyPreview = (envelope.body ?? '').slice(0, 200);
    logger.info(`AdviceDelivery: [${envelope.tag}] ${bodyPreview}${(envelope.body?.length ?? 0) > 200 ? '...' : ''}`);

    // Try Foundry first
    const foundryOk = await this.foundry.deliver(envelope);

    if (foundryOk) {
      // Foundry succeeded — check if we need to post a recovery notice
      if (!this.foundryAvailable) {
        this.foundryAvailable = true;
        this.lastFoundryWarningTime = 0;
        logger.info('AdviceDelivery: Foundry reconnected — delivery returning to Foundry whispers');
        await this.discord.deliverSystemMessage(
          'Foundry MCP reconnected. Advice delivery returning to Foundry whispers.'
        );
      }
      logger.info(`AdviceDelivery: delivered [${envelope.tag}] via Foundry`);
      return 'foundry';
    }

    // Foundry failed — handle status notifications
    const wasAvailable = this.foundryAvailable;
    this.foundryAvailable = false;

    if (wasAvailable) {
      // First failure — post dedicated warning
      logger.warn('AdviceDelivery: Foundry unavailable — falling back to Discord');
      this.lastFoundryWarningTime = Date.now();
      await this.discord.deliverSystemMessage(
        'Foundry MCP not connected. Advice will be delivered via Discord until Foundry is restored.'
      );
    } else {
      // Periodic reminder (every 30 minutes)
      const now = Date.now();
      if (now - this.lastFoundryWarningTime >= FOUNDRY_WARNING_INTERVAL_MS) {
        this.lastFoundryWarningTime = now;
        await this.discord.deliverSystemMessage(
          'Foundry MCP still unavailable. Advice continues via Discord.'
        );
      }
    }

    // Fall back to Discord with [VIA DISCORD] prefix
    const discordOk = await this.discord.deliver(envelope, true);
    if (discordOk) {
      logger.info(`AdviceDelivery: delivered [${envelope.tag}] via Discord (Foundry fallback)`);
      return 'discord';
    }

    logger.warn(`AdviceDelivery: failed to deliver [${envelope.tag}] to any output`);
    return 'none';
  }

  /**
   * Post a system message (readiness report, warnings) to Discord and Foundry.
   * Returns true if at least one channel succeeded.
   */
  async postSystemMessage(message: string): Promise<boolean> {
    const results = await Promise.allSettled([
      this.discord.deliverSystemMessage(message),
      this.foundry.deliverSystemMessage(message),
    ]);

    const discordOk = results[0].status === 'fulfilled' && results[0].value;
    const foundryOk = results[1].status === 'fulfilled' && results[1].value;

    if (discordOk || foundryOk) {
      const channels = [discordOk && 'Discord', foundryOk && 'Foundry'].filter(Boolean).join(' + ');
      logger.info(`AdviceDelivery: system message posted to ${channels}`);
      return true;
    }

    logger.warn('AdviceDelivery: system message failed on all channels');
    return false;
  }
}
