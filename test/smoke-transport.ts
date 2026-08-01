/**
 * Transport-selection smoke test.
 *
 * Regression guard for the GM → Discord MCP transport mismatch: the Discord MCP
 * server moved to StreamableHTTP (/mcp) but the GM client still defaulted the
 * Discord connection to SSE (/sse), breaking startup/tool access.
 *
 * Proves, without any network I/O:
 *   - buildServerConfigs() selects StreamableHTTP for Discord, Foundry, and Wiki.
 *   - mcpEndpointPath() maps each transport to the correct HTTP path.
 *   - The resulting base URL + path resolve to the expected /mcp endpoint.
 *
 * Run: npm run test:transport  (or npx tsx test/smoke-transport.ts)
 */

import { buildServerConfigs, mcpEndpointPath, type McpServerConfig } from '../src/mcp/client.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

const config = {
  discordMcpUrl: 'http://127.0.0.1:3001',
  discordMcpToken: 'discord-token',
  foundryMcpUrl: 'http://127.0.0.1:3002',
  foundryMcpToken: 'foundry-token',
  wikiMcpUrl: 'http://127.0.0.1:3003',
  wikiMcpToken: 'wiki-token',
  wikiMcpLocalSecret: 'local-secret',
};

console.log('\n── mcpEndpointPath ─────────────────────────────────────────');
assert(mcpEndpointPath('streamable-http') === '/mcp', 'streamable-http → /mcp');
assert(mcpEndpointPath('sse') === '/sse', 'sse → /sse (legacy path still supported)');

console.log('\n── buildServerConfigs: transport selection ─────────────────');
const configs = buildServerConfigs(config);
const byName = (n: string): McpServerConfig | undefined => configs.find((c) => c.name === n);

const discord = byName('discord');
const foundry = byName('foundry');
const wiki = byName('wiki');

assert(!!discord, 'discord server config present');
assert(discord?.transport === 'streamable-http', 'discord defaults to streamable-http (NOT sse)');
assert(discord?.required === true, 'discord required');

assert(foundry?.transport === 'streamable-http', 'foundry uses streamable-http');
assert(foundry?.required === false, 'foundry optional');

assert(wiki?.transport === 'streamable-http', 'wiki uses streamable-http');
assert(wiki?.required === true, 'wiki required (hard gate)');
assert(wiki?.localSecret === 'local-secret', 'wiki carries X-MCP-Local secret');

console.log('\n── no server defaults to SSE / no /sse endpoint ────────────');
assert(configs.every((c) => c.transport === 'streamable-http'), 'every configured server is streamable-http');
for (const c of configs) {
  const path = mcpEndpointPath(c.transport);
  const resolved = new URL(path, c.url);
  assert(path === '/mcp', `${c.name} resolves to /mcp path`);
  assert(resolved.pathname === '/mcp', `${c.name} URL → ${resolved.href}`);
}

console.log('\n── wiki omitted when URL is absent ─────────────────────────');
const noWiki = buildServerConfigs({ ...config, wikiMcpUrl: '' });
assert(!noWiki.some((c) => c.name === 'wiki'), 'wiki config omitted when wikiMcpUrl empty');

console.log(`\n${'═'.repeat(60)}`);
console.log(`Transport smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
