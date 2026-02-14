/**
 * Advice delivery orchestrator — delivers to all configured outputs in parallel.
 */

import { logger } from '../logger.js';
import { FoundryAdviceOutput } from './foundry-sidebar.js';
import { DiscordChannelOutput } from './discord-channel.js';
import type { McpAggregator } from '../mcp/client.js';
import type { GmAdvice } from '../types/index.js';

export class AdviceDelivery {
  private foundry: FoundryAdviceOutput;
  private discord: DiscordChannelOutput;

  constructor(mcp: McpAggregator) {
    this.foundry = new FoundryAdviceOutput(mcp);
    this.discord = new DiscordChannelOutput();
  }

  async deliver(advice: GmAdvice): Promise<void> {
    const results = await Promise.allSettled([
      this.foundry.deliver(advice),
      this.discord.deliver(advice),
    ]);

    const delivered = results.filter(
      (r) => r.status === 'fulfilled' && r.value === true
    ).length;

    if (delivered === 0) {
      logger.warn('AdviceDelivery: failed to deliver to any output');
    } else {
      logger.info(`AdviceDelivery: delivered to ${delivered} output(s)`);
    }
  }
}
