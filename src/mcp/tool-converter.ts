/**
 * Converts MCP tool schemas to Anthropic API tool format.
 */

import type Anthropic from '@anthropic-ai/sdk';

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Convert an MCP tool definition to Anthropic API tool format, prefixing the name
 * with a server identifier (e.g., 'discord__', 'foundry__', 'wiki__').
 */
export function mcpToolToAnthropic(
  serverName: string,
  mcpTool: McpToolSchema
): Anthropic.Messages.Tool {
  const prefixedName = `${serverName}__${mcpTool.name}`;

  // Anthropic requires input_schema with type: 'object'
  const inputSchema = mcpTool.inputSchema ?? { type: 'object', properties: {} };

  return {
    name: prefixedName,
    description: mcpTool.description ?? '',
    input_schema: inputSchema as unknown as Anthropic.Messages.Tool['input_schema'],
  };
}

/**
 * Parse a prefixed tool name back to server name and original tool name.
 * e.g., 'foundry__send_whisper' → { server: 'foundry', tool: 'send_whisper' }
 */
export function parsePrefixedToolName(prefixedName: string): { server: string; tool: string } | null {
  const idx = prefixedName.indexOf('__');
  if (idx === -1) return null;
  return {
    server: prefixedName.slice(0, idx),
    tool: prefixedName.slice(idx + 2),
  };
}
