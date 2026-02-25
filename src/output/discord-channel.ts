/**
 * Advice delivery to Discord via webhook (backup channel).
 * v2: formats AdviceEnvelope with **[TAG]** Markdown prefix.
 */

import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { AdviceEnvelope } from '../types/index.js';

export class DiscordChannelOutput {
  async deliver(envelope: AdviceEnvelope): Promise<boolean> {
    const config = getConfig();
    if (!config.discordAdviceWebhookUrl) {
      return false;
    }

    const body = {
      content: `**[${envelope.tag}]** ${envelope.body ?? ''}`,
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
}
