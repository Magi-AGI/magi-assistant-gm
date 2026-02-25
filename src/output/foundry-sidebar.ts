/**
 * Advice delivery to Foundry VTT via whispered chat messages.
 * v2: formats AdviceEnvelope with category-colored [TAG] prefix.
 */

import { logger } from '../logger.js';
import type { McpAggregator } from '../mcp/client.js';
import type { AdviceEnvelope, AdviceCategory } from '../types/index.js';

/** Category → HTML color for the tag prefix. */
const CATEGORY_COLORS: Record<AdviceCategory, string> = {
  script: '#4a9eff',       // blue
  'gap-fill': '#00bcd4',   // cyan — fast, urgent, distinct from script blue
  pacing: '#ff9800',       // orange
  continuity: '#9c27b0',   // purple
  spotlight: '#4caf50',    // green
  mechanics: '#795548',    // brown
  technical: '#607d8b',    // grey
  creative: '#e91e63',     // pink
  none: '#9e9e9e',         // grey
};

export class FoundryAdviceOutput {
  constructor(private mcp: McpAggregator) {}

  async deliver(envelope: AdviceEnvelope): Promise<boolean> {
    if (!this.mcp.isConnected('foundry')) {
      logger.warn('FoundryAdviceOutput: Foundry MCP not connected — skipping');
      return false;
    }

    const color = CATEGORY_COLORS[envelope.category] || CATEGORY_COLORS.none;
    let html = `<p><strong style="color:${color}">[${envelope.tag}]</strong> ${envelope.body ?? ''}</p>`;

    // Append image suggestion text when present
    if (envelope.image) {
      html += `<p style="color:#888; font-style:italic">📷 Image suggestion: ${envelope.image.description} (${envelope.image.path}) — Type /yes in Discord to post.</p>`;
    }

    try {
      await this.mcp.callTool('foundry__send_whisper', {
        content: html,
        title: 'Magi GM Assistant',
      });
      logger.info(`FoundryAdviceOutput: delivered [${envelope.tag}] to Foundry`);
      return true;
    } catch (err) {
      logger.error('FoundryAdviceOutput: failed to deliver:', err);
      return false;
    }
  }
}
