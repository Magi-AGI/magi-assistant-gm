/**
 * Advice delivery to Discord via webhook.
 * v4: supports [VIA DISCORD] fallback prefix and system messages.
 */

import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { AdviceEnvelope } from '../types/index.js';

export class DiscordChannelOutput {
  /**
   * Deliver an advice envelope to the Discord webhook.
   * @param envelope — The advice envelope to deliver.
   * @param fallbackMode — If true, prefix with [VIA DISCORD] to indicate Foundry is unavailable.
   */
  async deliver(envelope: AdviceEnvelope, fallbackMode = false): Promise<boolean> {
    const config = getConfig();
    if (!config.discordAdviceWebhookUrl) {
      return false;
    }

    const prefix = fallbackMode
      ? `**[VIA DISCORD]** **[${envelope.tag}]**`
      : `**[${envelope.tag}]**`;

    const body = {
      content: `${prefix} ${envelope.body ?? ''}`,
      username: 'Magi GM Assistant',
      // Prevent model-generated @everyone/@here/role mentions
      allowed_mentions: { parse: [] },
    };

    try {
      const response = await fetch(config.discordAdviceWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        logger.warn(`DiscordChannelOutput: webhook returned ${response.status}`);
        return false;
      }

      logger.debug(`DiscordChannelOutput: delivered [${envelope.tag}] to Discord webhook`);
      return true;
    } catch (err) {
      logger.error('DiscordChannelOutput: failed to deliver:', err);
      return false;
    }
  }

  /**
   * Post a system message (status notifications, warnings) to the Discord webhook.
   */
  async deliverSystemMessage(message: string): Promise<boolean> {
    const config = getConfig();
    if (!config.discordAdviceWebhookUrl) {
      return false;
    }

    const body = {
      content: message,
      username: 'Magi GM Assistant',
      allowed_mentions: { parse: [] },
    };

    try {
      const response = await fetch(config.discordAdviceWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        logger.warn(`DiscordChannelOutput: system message webhook returned ${response.status}`);
        return false;
      }

      logger.debug('DiscordChannelOutput: system message delivered');
      return true;
    } catch (err) {
      logger.error('DiscordChannelOutput: failed to deliver system message:', err);
      return false;
    }
  }
}
