/**
 * Advice delivery to Discord via webhook (backup channel).
 */

import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { GmAdvice } from '../types/index.js';

export class DiscordChannelOutput {
  async deliver(advice: GmAdvice): Promise<boolean> {
    const config = getConfig();
    if (!config.discordAdviceWebhookUrl) {
      return false;
    }

    const triggerLabel = advice.trigger.replace('_', ' ');
    const body = {
      content: `**[${triggerLabel}]** ${advice.advice}`,
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

      logger.debug('DiscordChannelOutput: delivered advice to Discord webhook');
      return true;
    } catch (err) {
      logger.error('DiscordChannelOutput: failed to deliver:', err);
      return false;
    }
  }
}
