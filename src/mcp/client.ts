/**
 * MCP aggregator client — connects to Discord, Foundry, and Wiki MCP servers.
 * Discovers tools from each, prefixes names, routes tool calls.
 */

import { EventEmitter } from 'events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { mcpToolToAnthropic, parsePrefixedToolName } from './tool-converter.js';

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface ServerConnection {
  client: Client;
  tools: McpToolDef[];
  transport: SSEClientTransport | StreamableHTTPClientTransport;
  url: string;
  required: boolean;
}

export interface McpAggregatorEvents {
  resourceUpdated: [server: string, uri: string];
}

export class McpAggregator extends EventEmitter<McpAggregatorEvents> {
  private servers = new Map<string, ServerConnection>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private serverConfigs: Array<{ name: string; url: string; token: string; required: boolean; transport: 'sse' | 'streamable-http' }> = [];
  private _shuttingDown = false;
  private _cleaningUp = false;

  /**
   * Connect to all configured MCP servers in parallel.
   * v2: All three servers are required (wiki is a hard gate).
   */
  async connect(): Promise<void> {
    const config = getConfig();

    this.serverConfigs = [
      { name: 'discord', url: config.discordMcpUrl, token: config.discordMcpToken, required: true, transport: 'sse' },
      { name: 'foundry', url: config.foundryMcpUrl, token: config.foundryMcpToken, required: false, transport: 'sse' },
    ];

    // v2: Wiki is required (hard gate) — uses Streamable HTTP (wiki SSE transport is send-only)
    if (config.wikiMcpUrl) {
      this.serverConfigs.push({ name: 'wiki', url: config.wikiMcpUrl, token: config.wikiMcpToken, required: true, transport: 'streamable-http' });
    }

    const results = await Promise.allSettled(
      this.serverConfigs.map((conn) => this.connectServer(conn.name, conn.url, conn.token, conn.required, conn.transport))
    );

    // Check for required connection failures
    let requiredFailure: string | null = null;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const conn = this.serverConfigs[i];
      if (result.status === 'rejected') {
        if (conn.required) {
          requiredFailure = `Failed to connect to required MCP server '${conn.name}': ${result.reason}`;
        } else {
          logger.warn(`Failed to connect to optional MCP server '${conn.name}':`, result.reason);
        }
      }
    }

    // If a required server failed, clean up any successful partial connections before throwing.
    // Set _cleaningUp flag to suppress reconnect scheduling from onclose handlers.
    if (requiredFailure) {
      this._cleaningUp = true;
      for (const [name, conn] of this.servers) {
        try {
          await conn.transport.close();
          logger.info(`MCP aggregator: cleaned up partial connection to '${name}'`);
        } catch { /* ignore cleanup errors */ }
      }
      this.servers.clear();
      this._cleaningUp = false;
      throw new Error(requiredFailure);
    }
  }

  private async connectServer(name: string, baseUrl: string, token: string, required: boolean, transportType: 'sse' | 'streamable-http' = 'sse'): Promise<void> {
    const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

    let transport: SSEClientTransport | StreamableHTTPClientTransport;
    if (transportType === 'streamable-http') {
      const httpUrl = new URL('/mcp', baseUrl);
      transport = new StreamableHTTPClientTransport(httpUrl, {
        requestInit: { headers: authHeaders },
      });
    } else {
      const sseUrl = new URL('/sse', baseUrl);
      if (token) {
        sseUrl.searchParams.set('token', token);
      }
      transport = new SSEClientTransport(sseUrl, {
        requestInit: { headers: authHeaders },
      });
    }
    const client = new Client(
      { name: `magi-gm-${name}`, version: '0.1.0' },
      { capabilities: {} }
    );

    // Timeout: if handshake doesn't complete in 10s, close transport and abort
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          connectTimer = setTimeout(() => {
            transport.close().catch(() => {});
            reject(new Error(`MCP connect to '${name}' timed out after 10s`));
          }, 10_000);
        }),
      ]);
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
    }

    // Discover tools
    const toolsResult = await client.listTools();
    const tools: McpToolDef[] = (toolsResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));

    this.servers.set(name, { client, tools, transport, url: baseUrl, required });
    logger.info(`MCP aggregator: connected to '${name}' — ${tools.length} tools`);

    // Monitor for disconnection — SSEClientTransport emits 'close' or errors
    transport.onclose = () => {
      if (this._shuttingDown || this._cleaningUp) return;
      logger.warn(`MCP aggregator: lost connection to '${name}' — scheduling reconnect`);
      this.servers.delete(name);
      this.scheduleReconnect(name, baseUrl, token, required, transportType);
    };

    transport.onerror = (err) => {
      if (this._shuttingDown || this._cleaningUp) return;
      logger.warn(`MCP aggregator: error on '${name}':`, err);
      // onclose will fire after onerror, triggering reconnect
    };
  }

  private scheduleReconnect(name: string, baseUrl: string, token: string, required: boolean, transportType: 'sse' | 'streamable-http' = 'sse', attempt = 1): void {
    if (this._shuttingDown) return;
    if (this.reconnectTimers.has(name)) return; // Already scheduled

    // Exponential backoff: 2s, 4s, 8s, 16s, 30s cap
    const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30_000);
    logger.info(`MCP aggregator: reconnecting to '${name}' in ${delay}ms (attempt ${attempt})`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(name);
      try {
        await this.connectServer(name, baseUrl, token, required, transportType);
        logger.info(`MCP aggregator: reconnected to '${name}'`);
      } catch (err) {
        logger.warn(`MCP aggregator: reconnect to '${name}' failed:`, err);
        this.scheduleReconnect(name, baseUrl, token, required, transportType, attempt + 1);
      }
    }, delay);

    this.reconnectTimers.set(name, timer);
  }

  /** Get all tools in Anthropic API format with server-prefixed names. */
  getAllTools(): Anthropic.Messages.Tool[] {
    const allTools: Anthropic.Messages.Tool[] = [];
    for (const [serverName, conn] of this.servers) {
      for (const tool of conn.tools) {
        allTools.push(mcpToolToAnthropic(serverName, tool));
      }
    }
    return allTools;
  }

  /** Route a prefixed tool call to the correct server. */
  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<unknown> {
    const parsed = parsePrefixedToolName(prefixedName);
    if (!parsed) {
      throw new Error(`Invalid tool name format: ${prefixedName}`);
    }

    const conn = this.servers.get(parsed.server);
    if (!conn) {
      throw new Error(`MCP server '${parsed.server}' not connected`);
    }

    const result = await conn.client.callTool({
      name: parsed.tool,
      arguments: args,
    });

    return result;
  }

  /** Read a resource from a specific server. */
  async readResource(serverName: string, uri: string, timeoutMs = 15_000): Promise<string> {
    const conn = this.servers.get(serverName);
    if (!conn) {
      throw new Error(`MCP server '${serverName}' not connected`);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        conn.client.readResource({ uri }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`MCP readResource('${serverName}', '${uri}') timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      const content = result.contents?.[0];
      if (!content) {
        return '';
      }
      if ('text' in content) {
        return content.text as string;
      }
      return JSON.stringify(content);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Check if a specific server is connected. */
  isConnected(serverName: string): boolean {
    return this.servers.has(serverName);
  }

  /**
   * Health check: verify a server responds to a lightweight probe.
   * Returns true if healthy, false if not connected or probe fails.
   */
  async healthCheck(serverName: string): Promise<boolean> {
    if (!this.isConnected(serverName)) return false;
    try {
      // Use a lightweight probe per server type
      switch (serverName) {
        case 'discord':
          await this.readResource('discord', 'session://active', 5000);
          break;
        case 'foundry':
          await this.readResource('foundry', 'game://state', 5000);
          break;
        case 'wiki': {
          // Wiki health: listTools is lightweight and doesn't depend on any specific card existing
          const conn = this.servers.get('wiki');
          if (conn) await conn.client.listTools();
          break;
        }
        default:
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Disconnect from all servers and cancel pending reconnects. */
  async disconnect(): Promise<void> {
    this._shuttingDown = true;

    // Cancel all pending reconnect timers
    for (const [, timer] of this.reconnectTimers) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    for (const [name, conn] of this.servers) {
      try {
        await conn.transport.close();
        logger.info(`MCP aggregator: disconnected from '${name}'`);
      } catch (err) {
        logger.warn(`MCP aggregator: error disconnecting from '${name}':`, err);
      }
    }
    this.servers.clear();
  }
}
