/**
 * MCP reconnect-hardening smoke test.
 *
 * Regression guard for the 2026-08-15 prod incident: restarting the Foundry MCP
 * server after GM caused the SDK to exhaust its own SSE reconnection budget and
 * emit only `onerror` (never `onclose`). GM's old handler just logged, so the
 * server stayed in the `servers` map, `isConnected()` kept returning true, and
 * the outer reconnect ladder never ran — GM stayed systemd-active but degraded
 * until manually restarted.
 *
 * Proves, without any network I/O:
 *   - a terminal transport error with a failing liveness probe tears down and
 *     schedules exactly one reconnect,
 *   - a transport error with a PASSING probe leaves the connection alone,
 *   - the failure handler cannot re-enter itself (probe → send → onerror),
 *   - onerror followed by onclose yields one ladder, not two,
 *   - shutdown/cleanup suppress reconnect,
 *   - a stale/superseded transport cannot tear down the live connection,
 *   - the backoff ladder is unchanged,
 *   - handlers installed before client.connect() keep the SDK Protocol wrapper
 *     in the chain (installing after connect silently discards it).
 *
 * Run: npm run test:reconnect  (or npx tsx test/smoke-reconnect.ts)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpAggregator, type McpTransportType } from '../src/mcp/client.js';

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

const RECONNECT = {
  baseUrl: 'http://127.0.0.1:3002',
  token: 'foundry-token',
  required: false,
  transportType: 'streamable-http' as McpTransportType,
  localSecret: '',
};

/** Minimal transport stand-in. Only the surface the aggregator touches. */
class FakeTransport {
  onclose?: () => void;
  onerror?: (err: Error) => void;
  onmessage?: (msg: unknown) => void;
  closed = false;
  async start(): Promise<void> {}
  async send(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
  }
}

interface Harness {
  agg: McpAggregator;
  transport: FakeTransport;
  client: { close: () => Promise<void> };
  probeCount: () => number;
  closeCount: () => number;
  timerCount: () => number;
  fail: (
    transport: FakeTransport,
    reason: string,
    definitive: boolean
  ) => Promise<void>;
  cleanup: () => void;
}

/**
 * Build an aggregator with one pre-registered fake connection.
 * Uses the real server name 'foundry' because healthCheck() switches on it —
 * an unknown name would hit the `default: return false` arm and always look
 * unhealthy, which would make the passing-probe case untestable.
 */
function harness(opts: { healthy: boolean; onProbe?: () => void }): Harness {
  const agg = new McpAggregator();
  const transport = new FakeTransport();
  let probes = 0;
  let closes = 0;

  const client = {
    async readResource(): Promise<unknown> {
      probes++;
      opts.onProbe?.();
      if (!opts.healthy) throw new Error('HTTP 404: session not found (stale session id)');
      return { contents: [{ text: '{}' }] };
    },
    async listTools(): Promise<unknown> {
      return { tools: [] };
    },
    async close(): Promise<void> {
      closes++;
    },
  };

  const internals = agg as unknown as {
    servers: Map<string, unknown>;
    reconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
    _shuttingDown: boolean;
    _cleaningUp: boolean;
    handleTransportFailure: (
      name: string,
      transport: unknown,
      client: unknown,
      reason: string,
      definitive: boolean,
      reconnect: typeof RECONNECT
    ) => Promise<void>;
  };

  internals.servers.set('foundry', {
    client,
    tools: [],
    transport,
    url: RECONNECT.baseUrl,
    required: false,
  });

  return {
    agg,
    transport,
    client,
    probeCount: () => probes,
    closeCount: () => closes,
    timerCount: () => internals.reconnectTimers.size,
    fail: (t, reason, definitive) =>
      internals.handleTransportFailure('foundry', t, client, reason, definitive, RECONNECT),
    cleanup: () => {
      internals._shuttingDown = true;
      for (const [, timer] of internals.reconnectTimers) clearTimeout(timer);
      internals.reconnectTimers.clear();
    },
  };
}

// Wrapped in main(): this repo's tsx transform targets CJS, which rejects
// top-level await.
async function main(): Promise<void> {

// ── T1: terminal SDK error + failing probe → teardown + one ladder ──────────
console.log('\n── T1 terminal SDK error, failing probe ────────────────────');
{
  const h = harness({ healthy: false });
  assert(h.agg.isConnected('foundry'), 'precondition: connected');
  await h.fail(h.transport, 'Maximum reconnection attempts (2) exceeded.', false);
  assert(!h.agg.isConnected('foundry'), 'server removed from map after failed probe');
  assert(h.timerCount() === 1, 'exactly one reconnect timer scheduled');
  assert(h.closeCount() === 1, 'client.close() called once (protocol cleanup)');
  h.cleanup();
}

// ── T2: transport error + passing probe → connection preserved ──────────────
console.log('\n── T2 transport error, passing probe ───────────────────────');
{
  const h = harness({ healthy: true });
  await h.fail(h.transport, 'transient stream hiccup', false);
  assert(h.agg.isConnected('foundry'), 'connection kept when probe passes');
  assert(h.timerCount() === 0, 'no reconnect scheduled on a healthy probe');
  assert(h.closeCount() === 0, 'connection not closed on a healthy probe');
  h.cleanup();
}

// ── T3: reentrancy — a probe that re-fires onerror must not recurse ─────────
console.log('\n── T3 reentrancy guard ─────────────────────────────────────');
{
  let reentered = 0;
  let h: Harness | null = null;
  h = harness({
    healthy: false,
    onProbe: () => {
      // Simulate the SDK re-invoking onerror from inside the failing send().
      reentered++;
      if (reentered < 5 && h) void h.fail(h.transport, 're-entrant error', false);
    },
  });
  await h.fail(h.transport, 'Maximum reconnection attempts (2) exceeded.', false);
  assert(h.probeCount() === 1, 'liveness probe ran exactly once despite re-entry');
  assert(h.timerCount() === 1, 'exactly one reconnect timer despite re-entry');
  assert(!h.agg.isConnected('foundry'), 'torn down exactly once');
  h.cleanup();
}

// ── T4: onerror then onclose → one ladder ───────────────────────────────────
console.log('\n── T4 onerror then onclose ─────────────────────────────────');
{
  const h = harness({ healthy: false });
  await h.fail(h.transport, 'Maximum reconnection attempts (2) exceeded.', false);
  await h.fail(h.transport, 'connection closed', true);
  assert(h.timerCount() === 1, 'second (close) callback did not schedule a duplicate ladder');
  assert(h.probeCount() === 1, 'close path did not run another probe');
  h.cleanup();
}

// ── T5: shutdown / cleanup suppression ──────────────────────────────────────
console.log('\n── T5 shutdown and cleanup suppression ─────────────────────');
{
  const h = harness({ healthy: false });
  (h.agg as unknown as { _shuttingDown: boolean })._shuttingDown = true;
  await h.fail(h.transport, 'connection closed', true);
  assert(h.timerCount() === 0, 'no reconnect while _shuttingDown');
  assert(h.agg.isConnected('foundry'), 'no teardown while _shuttingDown');
  h.cleanup();
}
{
  const h = harness({ healthy: false });
  (h.agg as unknown as { _cleaningUp: boolean })._cleaningUp = true;
  await h.fail(h.transport, 'connection closed', true);
  assert(h.timerCount() === 0, 'no reconnect while _cleaningUp');
  h.cleanup();
}

// ── T6: stale-session POST failure (not the max-retries string) ─────────────
console.log('\n── T6 stale-session POST failure path ──────────────────────');
{
  const h = harness({ healthy: false });
  await h.fail(h.transport, 'Streamable HTTP error: HTTP 404: session not found', false);
  assert(!h.agg.isConnected('foundry'), 'stale-session error also triggers teardown');
  assert(h.timerCount() === 1, 'reconnect scheduled without matching the max-retries string');
  h.cleanup();
}

// ── T7: superseded transport must not tear down the live connection ─────────
console.log('\n── T7 stale transport identity ─────────────────────────────');
{
  const h = harness({ healthy: false });
  const stale = new FakeTransport();
  await h.fail(stale, 'Maximum reconnection attempts (2) exceeded.', false);
  assert(h.agg.isConnected('foundry'), 'live connection untouched by stale transport callback');
  assert(h.timerCount() === 0, 'no reconnect scheduled from a stale transport');
  assert(h.probeCount() === 0, 'no probe run for a stale transport');
  h.cleanup();
}

// ── T8: backoff ladder unchanged ────────────────────────────────────────────
console.log('\n── T8 backoff ladder ───────────────────────────────────────');
{
  const agg = new McpAggregator();
  const internals = agg as unknown as {
    reconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
    scheduleReconnect: (
      name: string,
      baseUrl: string,
      token: string,
      required: boolean,
      transportType: McpTransportType,
      localSecret: string,
      attempt: number
    ) => void;
  };

  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const spares: ReturnType<typeof setTimeout>[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    const t = realSetTimeout(() => {}, 3_600_000);
    spares.push(t);
    return t;
  }) as typeof globalThis.setTimeout;

  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      internals.scheduleReconnect('foundry', RECONNECT.baseUrl, RECONNECT.token, false, 'streamable-http', '', attempt);
      internals.reconnectTimers.delete('foundry');
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    for (const t of spares) clearTimeout(t);
  }

  assert(delays[0] === 2000, 'attempt 1 → 2000ms');
  assert(delays[1] === 4000, 'attempt 2 → 4000ms');
  assert(delays[2] === 8000, 'attempt 3 → 8000ms');
  assert(delays[3] === 16000, 'attempt 4 → 16000ms');
  assert(delays[4] === 30000, 'attempt 5 → capped at 30000ms');
}

// ── T9: handler ordering preserves the SDK Protocol wrapper ─────────────────
// The bug this guards: Protocol.connect() chains whatever handler is already on
// the transport. Assigning transport.onclose AFTER client.connect() overwrites
// that wrapper, so Protocol._onclose() — which rejects pending requests and
// clears progress/notification state — never runs.
console.log('\n── T9 protocol wrapper preserved ───────────────────────────');
{
  /** Transport that completes an MCP handshake against a real Client. */
  class HandshakeTransport extends FakeTransport {
    override async send(msg?: unknown): Promise<void> {
      const m = msg as { id?: number; method?: string; params?: { protocolVersion?: string } };
      if (m?.method === 'initialize') {
        setTimeout(() => {
          this.onmessage?.({
            jsonrpc: '2.0',
            id: m.id,
            result: {
              protocolVersion: m.params?.protocolVersion,
              capabilities: {},
              serverInfo: { name: 'fake', version: '0.0.0' },
            },
          });
        }, 0);
      }
    }
  }

  // Install BEFORE connect — the shipped ordering.
  {
    const transport = new HandshakeTransport();
    const client = new Client({ name: 'test-before', version: '0.1.0' }, { capabilities: {} });
    let ours = false;
    let protocolCleanup = false;
    client.onclose = () => { protocolCleanup = true; };
    transport.onclose = () => { ours = true; };

    await client.connect(transport as never);
    transport.onclose?.();

    assert(ours, 'install-before-connect: GM handler still fires');
    assert(protocolCleanup, 'install-before-connect: SDK protocol cleanup ALSO fires');
  }

  // Negative control: install AFTER connect — the bug being guarded against.
  {
    const transport = new HandshakeTransport();
    const client = new Client({ name: 'test-after', version: '0.1.0' }, { capabilities: {} });
    let ours = false;
    let protocolCleanup = false;
    client.onclose = () => { protocolCleanup = true; };

    await client.connect(transport as never);
    transport.onclose = () => { ours = true; };
    transport.onclose?.();

    assert(ours, 'install-after-connect: GM handler fires');
    assert(!protocolCleanup, 'install-after-connect: protocol cleanup is LOST (documents the bug)');
  }
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`Reconnect smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

}

main().catch((err) => {
  console.error('Reconnect smoke: unexpected failure', err);
  process.exit(1);
});
