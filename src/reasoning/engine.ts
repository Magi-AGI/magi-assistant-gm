/**
 * Reasoning engine — invokes Claude with MCP tool use for GM advice.
 * Single-threaded: queues new triggers if processing is in progress.
 */

import { EventEmitter } from 'events';
import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { ContextAssembler } from './context.js';
import type { McpAggregator } from '../mcp/client.js';
import type { TriggerBatch, GmAdvice } from '../types/index.js';

const MAX_TOOL_ITERATIONS = 5;
const MAX_TOOL_RESULT_CHARS = 5000;
const NO_ADVICE_SENTINEL = 'NO_ADVICE';

export interface ReasoningEngineEvents {
  advice: [advice: GmAdvice];
}

/** Returns the current transcript cache snapshot for context assembly. */
export type TranscriptProvider = () => Array<{ text: string; userId?: string; displayName?: string; timestamp: string }>;

export class ReasoningEngine extends EventEmitter<ReasoningEngineEvents> {
  private client: Anthropic;
  private assembler: ContextAssembler;
  private mcp: McpAggregator;
  private getTranscript: TranscriptProvider;
  private processing = false;
  private queuedBatch: TriggerBatch | null = null;

  constructor(mcp: McpAggregator, transcriptProvider: TranscriptProvider) {
    super();
    const config = getConfig();
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    this.mcp = mcp;
    this.getTranscript = transcriptProvider;
    this.assembler = new ContextAssembler(mcp);
    this.assembler.loadTemplate();
  }

  /**
   * Process a trigger batch. If already processing, queues the batch
   * (freshest data wins — overwrites any previously queued batch).
   */
  async process(batch: TriggerBatch): Promise<GmAdvice | null> {
    if (this.processing) {
      logger.debug('ReasoningEngine: already processing — queuing batch');
      this.queuedBatch = batch;
      return null;
    }

    this.processing = true;
    let result: GmAdvice | null = null;
    try {
      result = await this.runReasoning(batch);
    } catch (err) {
      logger.error('ReasoningEngine: error:', err);
    }

    // Release lock, then drain queue.
    // JS is single-threaded so nothing can interleave between these two lines.
    this.processing = false;
    this.drainQueue();

    return result;
  }

  private drainQueue(): void {
    if (!this.queuedBatch) return;
    const next = this.queuedBatch;
    this.queuedBatch = null;
    // Re-enters process() which re-acquires the lock synchronously
    this.process(next).then((advice) => {
      if (advice) this.emit('advice', advice);
    }).catch((err) => {
      logger.error('ReasoningEngine: error processing queued batch:', err);
    });
  }

  private async runReasoning(batch: TriggerBatch): Promise<GmAdvice | null> {
    const config = getConfig();

    try {
      const context = await this.assembler.assemble(batch, this.getTranscript());
      logger.info(`ReasoningEngine: assembled context (~${context.estimatedTokens} tokens)`);

      const messages: Anthropic.Messages.MessageParam[] = [
        {
          role: 'user',
          content: `${context.gameState}\n\n## Current Situation\n${context.triggerSummary}\n\n## Recent Transcript\n${context.recentTranscript}`,
        },
      ];

      let response = await this.client.messages.create({
        model: config.anthropicModel,
        max_tokens: config.adviceMaxTokens,
        system: context.systemPrompt,
        messages,
        tools: context.tools as Anthropic.Messages.Tool[],
      });

      // Tool use loop — track calls to detect zombie loops (same tool+args repeated)
      let iterations = 0;
      const calledTools = new Set<string>();

      while (response.stop_reason === 'tool_use' && iterations < MAX_TOOL_ITERATIONS) {
        iterations++;

        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use'
        );

        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
        for (const toolUse of toolUseBlocks) {
          // Zombie guard: short-circuit if we've already called this exact tool+args
          const callKey = `${toolUse.name}:${JSON.stringify(toolUse.input)}`;
          if (calledTools.has(callKey)) {
            logger.warn(`ReasoningEngine: skipping duplicate tool call (${toolUse.name})`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: 'Error: This tool was already called with identical arguments. Use the previous result or try different arguments.',
              is_error: true,
            });
            continue;
          }
          calledTools.add(callKey);

          try {
            const result = await this.mcp.callTool(
              toolUse.name,
              toolUse.input as Record<string, unknown>
            );
            let content = typeof result === 'string' ? result : JSON.stringify(result);
            if (content.length > MAX_TOOL_RESULT_CHARS) {
              logger.warn(`ReasoningEngine: truncating tool result from ${toolUse.name} (${content.length} chars → ${MAX_TOOL_RESULT_CHARS})`);
              content = content.slice(0, MAX_TOOL_RESULT_CHARS) + '\n\n[Result truncated. Use more specific parameters to narrow the query.]';
            }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content,
            });
          } catch (err) {
            logger.warn(`ReasoningEngine: tool call failed (${toolUse.name}):`, err);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Error: ${err instanceof Error ? err.message : String(err)}. Do not retry this tool with the same arguments.`,
              is_error: true,
            });
          }
        }

        messages.push(
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults }
        );

        response = await this.client.messages.create({
          model: config.anthropicModel,
          max_tokens: config.adviceMaxTokens,
          system: context.systemPrompt,
          messages,
          tools: context.tools as Anthropic.Messages.Tool[],
        });
      }

      // Extract text response
      const textBlocks = response.content.filter(
        (block): block is Anthropic.Messages.TextBlock => block.type === 'text'
      );
      const adviceText = textBlocks.map((b) => b.text).join('\n').trim();

      // Check for NO_ADVICE sentinel
      if (!adviceText || adviceText === NO_ADVICE_SENTINEL) {
        logger.info('ReasoningEngine: Claude returned NO_ADVICE');
        return null;
      }

      logger.info(`ReasoningEngine: generated advice (${iterations} tool iterations)`);

      return {
        trigger: batch.events[0]?.type ?? 'heartbeat',
        context: batch.events.map((e) => `${e.type}:${e.source}`).join(', '),
        advice: adviceText,
        confidence: 1.0,
        sources: [],
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      logger.error('ReasoningEngine: error during reasoning:', err);
      return null;
    }
  }
}
