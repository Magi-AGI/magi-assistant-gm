/**
 * v2 Reasoning engine — invokes Claude with MCP tool use for GM advice.
 * Single-threaded: queues new triggers if processing is in progress.
 * Parses JSON advice envelopes, checks dedup, pushes to advice memory.
 */

import { EventEmitter } from 'events';
import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { ContextAssembler } from './context.js';
import { parseAdviceEnvelope, wrapFreeTextAsEnvelope, isNoAdvice } from './envelope-parser.js';
import type { McpAggregator } from '../mcp/client.js';
import type { PacingStateManager } from '../state/pacing.js';
import type { AdviceMemoryBuffer } from '../state/advice-memory.js';
import type { TriggerBatch, AdviceEnvelope, TriggerPriority, NpcCacheEntry, SceneIndexEntry } from '../types/index.js';

const MAX_TOOL_ITERATIONS = 5;
const MAX_TOOL_RESULT_CHARS = 5000;

export interface ReasoningEngineEvents {
  advice: [envelope: AdviceEnvelope];
}

/** Returns the current transcript cache snapshot for context assembly. */
export type TranscriptProvider = () => Array<{ text: string; userId?: string; displayName?: string; timestamp: string }>;

export class ReasoningEngine extends EventEmitter<ReasoningEngineEvents> {
  private client: Anthropic;
  private assembler: ContextAssembler;
  private mcp: McpAggregator;
  private pacing: PacingStateManager;
  private memory: AdviceMemoryBuffer;
  private getTranscript: TranscriptProvider;
  private processing = false;
  private queuedBatch: TriggerBatch | null = null;

  constructor(
    mcp: McpAggregator,
    pacing: PacingStateManager,
    memory: AdviceMemoryBuffer,
    transcriptProvider: TranscriptProvider,
  ) {
    super();
    const config = getConfig();
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    this.mcp = mcp;
    this.pacing = pacing;
    this.memory = memory;
    this.getTranscript = transcriptProvider;
    this.assembler = new ContextAssembler(mcp, pacing, memory);
    this.assembler.loadTemplate();
  }

  /** Forward NPC cache to the context assembler for injection into context. */
  setNpcCache(cache: NpcCacheEntry[]): void {
    this.assembler.setNpcCache(cache);
  }

  /** Forward scene index to the context assembler for injection into context. */
  setSceneIndex(index: SceneIndexEntry[]): void {
    this.assembler.setSceneIndex(index);
  }

  /**
   * Process a trigger batch. If already processing, queues the batch
   * (freshest data wins — overwrites any previously queued batch).
   */
  async process(batch: TriggerBatch): Promise<AdviceEnvelope | null> {
    if (this.processing) {
      logger.debug('ReasoningEngine: already processing — queuing batch');
      this.queuedBatch = batch;
      return null;
    }

    this.processing = true;
    let result: AdviceEnvelope | null = null;
    try {
      result = await this.runReasoning(batch);
    } catch (err) {
      logger.error('ReasoningEngine: error:', err);
    }

    this.processing = false;
    this.drainQueue();

    return result;
  }

  private drainQueue(): void {
    if (!this.queuedBatch) return;
    const next = this.queuedBatch;
    this.queuedBatch = null;
    // Delay before processing the next batch to avoid back-to-back API calls
    // that could hit the org-level rate limit (30k tokens/min).
    const INTER_CALL_DELAY_MS = 10_000;
    setTimeout(() => {
      this.process(next).then((envelope) => {
        if (envelope) this.emit('advice', envelope);
      }).catch((err) => {
        logger.error('ReasoningEngine: error processing queued batch:', err);
      });
    }, INTER_CALL_DELAY_MS);
  }

  private async runReasoning(batch: TriggerBatch): Promise<AdviceEnvelope | null> {
    const config = getConfig();

    try {
      const context = await this.assembler.assemble(batch, this.getTranscript());
      logger.info(`ReasoningEngine: assembled context (~${context.estimatedTokens} tokens)`);

      const messages: Anthropic.Messages.MessageParam[] = [
        {
          role: 'user',
          content: context.gameState,
        },
      ];

      let response = await this.client.messages.create({
        model: config.anthropicModel,
        max_tokens: config.adviceMaxTokens,
        system: context.systemPrompt,
        messages,
        tools: context.tools as Anthropic.Messages.Tool[],
      });

      // Tool use loop with zombie guard
      let iterations = 0;
      const calledTools = new Set<string>();

      while (response.stop_reason === 'tool_use' && iterations < MAX_TOOL_ITERATIONS) {
        iterations++;

        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use'
        );

        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
        for (const toolUse of toolUseBlocks) {
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
              logger.warn(`ReasoningEngine: truncating tool result from ${toolUse.name} (${content.length} → ${MAX_TOOL_RESULT_CHARS} chars)`);
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
      const adviceText = textBlocks.map(b => b.text).join('\n').trim();

      if (!adviceText) {
        logger.info('ReasoningEngine: empty response from Claude');
        return null;
      }

      // Parse as JSON envelope
      const highestPriority = Math.min(...batch.events.map(e => e.priority)) as TriggerPriority;
      let envelope = parseAdviceEnvelope(adviceText);
      if (!envelope) {
        // Fall back to free-text wrapping
        envelope = wrapFreeTextAsEnvelope(adviceText, highestPriority);
      }

      // Check NO_ADVICE sentinel
      if (isNoAdvice(envelope)) {
        logger.info('ReasoningEngine: Claude returned NO_ADVICE');
        return null;
      }

      // Dedup check against memory
      if (this.memory.isDuplicate(envelope)) {
        logger.info(`ReasoningEngine: dedup — suppressing duplicate advice [${envelope.tag}]`);
        return null;
      }

      // Anti-echo telemetry: check if advice body substantially overlaps with transcript
      this.checkAntiEcho(envelope, context.recentTranscript);

      // Wiki-first telemetry: log if a question was answered without referencing wiki cards
      if (batch.events.some(e => e.type === 'gm_question') && envelope.source_cards.length === 0) {
        logger.warn(`ReasoningEngine: wiki-first gap — question answered without wiki references [${envelope.tag}]`);
      }

      // Push to memory buffer
      this.memory.push(envelope);
      logger.info(`ReasoningEngine: generated advice [${envelope.tag}] (${iterations} tool iterations)`);

      return envelope;
    } catch (err) {
      logger.error('ReasoningEngine: error during reasoning:', err);
      return null;
    }
  }

  /**
   * Anti-echo telemetry: check if the advice body overlaps significantly
   * with recent transcript content. Logs a warning but does not block delivery.
   */
  private checkAntiEcho(envelope: AdviceEnvelope, transcript: string): void {
    if (!envelope.body || !transcript) return;

    const adviceWords = envelope.body.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (adviceWords.length < 4) return;

    const transcriptLower = transcript.toLowerCase();
    let overlapCount = 0;
    const totalNgrams = adviceWords.length - 3;

    for (let i = 0; i < totalNgrams; i++) {
      const ngram = adviceWords.slice(i, i + 4).join(' ');
      if (transcriptLower.includes(ngram)) overlapCount++;
    }

    const overlapRatio = overlapCount / totalNgrams;
    if (overlapRatio > 0.3) {
      logger.warn(
        `ReasoningEngine: anti-echo — ${Math.round(overlapRatio * 100)}% 4-gram overlap ` +
        `with transcript [${envelope.tag}]`
      );
    }
  }
}
