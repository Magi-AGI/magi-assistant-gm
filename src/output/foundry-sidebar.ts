/**
 * Advice delivery to Foundry VTT via whispered chat messages.
 * Uses the foundry__send_whisper MCP tool.
 */

import { logger } from '../logger.js';
import type { McpAggregator } from '../mcp/client.js';
import type { GmAdvice } from '../types/index.js';

/** Trigger type icons for advice messages. */
function triggerIcon(trigger: string): string {
  switch (trigger) {
    case 'question': return '&#10067;'; // ?
    case 'game_event': return '&#9876;'; // crossed swords
    case 'heartbeat': return '&#128161;'; // lightbulb
    case 'on_demand': return '&#128172;'; // speech bubble
    default: return '&#8505;'; // info
  }
}

export class FoundryAdviceOutput {
  constructor(private mcp: McpAggregator) {}

  async deliver(advice: GmAdvice): Promise<boolean> {
    if (!this.mcp.isConnected('foundry')) {
      logger.warn('FoundryAdviceOutput: Foundry MCP not connected — skipping');
      return false;
    }

    const icon = triggerIcon(advice.trigger);
    const html = `<p>${icon} ${advice.advice}</p>`;
    const title = 'Magi GM Assistant';

    try {
      await this.mcp.callTool('foundry__send_whisper', {
        content: html,
        title,
      });
      logger.info('FoundryAdviceOutput: delivered advice to Foundry');
      return true;
    } catch (err) {
      logger.error('FoundryAdviceOutput: failed to deliver:', err);
      return false;
    }
  }
}
