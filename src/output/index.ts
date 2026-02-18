/**
 * Advice delivery orchestrator — delivers to all configured outputs in parallel.
 * v2: accepts AdviceEnvelope instead of GmAdvice.
 */

import { logger } from '../logger.js';
import { FoundryAdviceOutput } from './foundry-sidebar.js';
import { DiscordChannelOutput } from './discord-channel.js';
import type { McpAggregator } from '../mcp/client.js';
import type { AdviceEnvelope } from '../types/index.js';

export class AdviceDelivery {
  private foundry: FoundryAdviceOutput;
  private discord: DiscordChannelOutput;

  constructor(mcp: McpAggregator) {
    this.foundry = new FoundryAdviceOutput(mcp);
    this.discord = new DiscordChannelOutput();
  }

  async deliver(envelope: AdviceEnvelope): Promise<void> {
    const results = await Promise.allSettled([
      this.foundry.deliver(envelope),
      this.discord.deliver(envelope),
    ]);

    const delivered = results.filter(
      r => r.status === 'fulfilled' && r.value === true
    ).length;

    if (delivered === 0) {
      logger.warn('AdviceDelivery: failed to deliver to any output');
    } else {
      logger.info(`AdviceDelivery: delivered [${envelope.tag}] to ${delivered} output(s)`);
    }
  }
}
