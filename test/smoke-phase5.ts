/**
 * Phase 5 validation test.
 *
 * Tests Phase 3-4 code paths: context assembly (trigger summaries, NPC block,
 * stripHtml, pre-fetch conditioning), anti-echo detection, and session lifecycle replay.
 * Run: npx tsx test/smoke-phase5.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { loadFuzzyMatchTable, TriggerDetector } from '../src/reasoning/triggers.js';
import { ContextAssembler } from '../src/reasoning/context.js';
import { PacingStateManager } from '../src/state/pacing.js';
import { AdviceMemoryBuffer } from '../src/state/advice-memory.js';
import { AssistantState, TriggerPriority } from '../src/types/index.js';
import type { NpcCacheEntry, SceneIndexEntry, TriggerBatch, TriggerEvent } from '../src/types/index.js';
import path from 'node:path';

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Mock MCP Aggregator ─────────────────────────────────────────────────────

/** Minimal mock that satisfies ContextAssembler's MCP needs. */
function createMockMcp(cardResponses: Record<string, string> = {}) {
  return {
    readResource(_server: string, _uri: string): Promise<string> {
      return Promise.resolve('{}');
    },
    callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      if (name === 'wiki__get_card') {
        const cardName = args.name as string;
        const html = cardResponses[cardName];
        if (html) {
          // Return MCP SDK format with JSON envelope
          return Promise.resolve({
            content: [{ type: 'text', text: JSON.stringify({ id: cardName, title: cardName, text: html }) }],
          });
        }
        return Promise.reject(new Error(`Card not found: ${cardName}`));
      }
      return Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
    },
    isConnected(_server: string): boolean {
      return true;
    },
    getAllTools(): unknown[] {
      return [];
    },
  };
}

// ── Setup ───────────────────────────────────────────────────────────────────

process.env.AUTO_ACTIVE_ENABLED = 'true';
process.env.AUTO_ACTIVE_THRESHOLD = '3';
process.env.AUTO_ACTIVE_WINDOW_MINUTES = '5';
process.env.AUTO_ACTIVE_MIN_TERM_LENGTH = '4';
process.env.WIKI_MCP_URL = 'http://fake';
process.env.ANTHROPIC_API_KEY = 'fake';

const fuzzyPath = path.resolve(process.cwd(), 'config', 'fuzzy-match.json');
const fuzzyTable = loadFuzzyMatchTable(fuzzyPath);

// ── Test 1: stripHtml structure preservation ────────────────────────────────

console.log('\n── Test 1: stripHtml structure preservation ──');

const pacing1 = new PacingStateManager();
const memory1 = new AdviceMemoryBuffer(5);
const assembler1 = new ContextAssembler(createMockMcp() as any, pacing1, memory1);
const stripHtml = (assembler1 as any).stripHtml.bind(assembler1);

assert(
  stripHtml('<p>First paragraph</p><p>Second paragraph</p>').includes('\n'),
  'Preserves paragraph breaks',
);
assert(
  stripHtml('<br>line one<br/>line two').includes('\n'),
  'Preserves <br> as newline',
);
assert(
  stripHtml('Tolkien &amp; Lewis').includes('Tolkien & Lewis'),
  'Decodes &amp; entity',
);
assert(
  stripHtml('&lt;script&gt;').includes('<script>'),
  'Decodes &lt;&gt; entities',
);
assert(
  stripHtml('<ul><li>Item A</li><li>Item B</li></ul>').includes('Item A\nItem B'),
  'Preserves list item breaks',
);
assert(
  stripHtml('A\n\n\n\nB').includes('A\n\nB'),
  'Collapses excessive newlines',
);

// ── Test 2: summarizeTriggers with all v3 types ─────────────────────────────

console.log('\n── Test 2: summarizeTriggers v3 types ──');

const summarize = (assembler1 as any).summarizeTriggers.bind(assembler1);

const allTriggerBatch: TriggerBatch = {
  events: [
    { type: 'gm_question', priority: TriggerPriority.P1, source: 'gm', data: { transcript: 'What is the name of the station?' }, timestamp: new Date().toISOString() },
    { type: 'gm_hesitation', priority: TriggerPriority.P1, source: 'hesitation', data: { transcript: 'uh the thing', silenceSeconds: 6 }, timestamp: new Date().toISOString() },
    { type: 'scene_transition', priority: TriggerPriority.P2, source: 'transcript', data: { transcript: 'next scene' }, timestamp: new Date().toISOString() },
    { type: 'scene_transition_detected', priority: TriggerPriority.P2, source: 'scene-index', data: { scene_title: 'Station Assault', scene_card: 'Episode+Station_Assault', matched_keywords: ['station', 'kreshling'] }, timestamp: new Date().toISOString() },
    { type: 'npc_first_appearance', priority: TriggerPriority.P2, source: 'npc-cache', data: { npc_name: 'Daokresh', npc_pronunciation: 'dow-KRESH', npc_brief: 'War chief', npc_card: 'Characters+Daokresh' }, timestamp: new Date().toISOString() },
    { type: 'act_transition', priority: TriggerPriority.P2, source: 'transcript', data: {}, timestamp: new Date().toISOString() },
    { type: 'pacing_gate_convergence', priority: TriggerPriority.P2, source: 'pacing-gate', data: { remaining_minutes: 40, open_threads: ['thread A', 'thread B'] }, timestamp: new Date().toISOString() },
    { type: 'pacing_gate_denouement', priority: TriggerPriority.P2, source: 'pacing-gate', data: { remaining_minutes: 15 }, timestamp: new Date().toISOString() },
    { type: 'pacing_alert', priority: TriggerPriority.P3, source: 'pacing', data: { elapsed: 15, planned: 10 }, timestamp: new Date().toISOString() },
    { type: 'silence_detection', priority: TriggerPriority.P4, source: 'silence', data: { silenceSeconds: 120 }, timestamp: new Date().toISOString() },
  ],
  flushedAt: new Date().toISOString(),
};

// Test with pre-fetch successful
const summaryWithPrefetch = summarize(allTriggerBatch, { sceneCardFetched: true, npcCardFetched: true });
assert(summaryWithPrefetch.includes('P1 — GM question'), 'Contains P1 question');
assert(summaryWithPrefetch.includes('P1-H — GM hesitation'), 'Contains P1-H hesitation');
assert(summaryWithPrefetch.includes('gap-fill'), 'Hesitation mentions gap-fill');
assert(summaryWithPrefetch.includes('Scene transition (source: transcript)'), 'Contains P2 scene transition');
assert(summaryWithPrefetch.includes('Station Assault'), 'Contains detected scene title');
assert(summaryWithPrefetch.includes('pre-fetched below'), 'Scene summary says pre-fetched when successful');
assert(summaryWithPrefetch.includes('Daokresh (dow-KRESH)'), 'Contains NPC with pronunciation');
assert(summaryWithPrefetch.includes('pre-fetched below'), 'NPC summary says pre-fetched when successful');
assert(summaryWithPrefetch.includes('Convergence gate'), 'Contains convergence gate');
assert(summaryWithPrefetch.includes('thread A, thread B'), 'Convergence includes open threads');
assert(summaryWithPrefetch.includes('Denouement gate'), 'Contains denouement gate');
assert(summaryWithPrefetch.includes('15min / 10min'), 'Contains pacing overrun stats');
assert(summaryWithPrefetch.includes('GM silence: 120s'), 'Contains silence detection');

// Test with pre-fetch failed
const summaryNoPrefetch = summarize(allTriggerBatch, { sceneCardFetched: false, npcCardFetched: false });
assert(summaryNoPrefetch.includes('wiki__get_card'), 'Scene summary falls back to wiki__get_card on failure');
assert(summaryNoPrefetch.includes('Characters+Daokresh'), 'NPC summary includes card path on failure');
assert(!summaryNoPrefetch.includes('pre-fetched below'), 'No pre-fetch claim when fetch failed');

// Test convergence escalation
const escalationBatch: TriggerBatch = {
  events: [
    { type: 'pacing_gate_convergence', priority: TriggerPriority.P2, source: 'pacing-gate', data: { remaining_minutes: 30, escalation: true, current_act: 1 }, timestamp: new Date().toISOString() },
  ],
  flushedAt: new Date().toISOString(),
};
const escalationSummary = summarize(escalationBatch, { sceneCardFetched: false, npcCardFetched: false });
assert(escalationSummary.includes('ESCALATION'), 'Convergence escalation flagged');
assert(escalationSummary.includes('Act 1'), 'Escalation includes current act');

// ── Test 3: NPC block formatting (served vs unserved) ───────────────────────

console.log('\n── Test 3: NPC block formatting ──');

(assembler1 as any).npcCache = [
  {
    key: 'daokresh', display_name: 'Daokresh', pronunciation: 'dow-KRESH',
    brief: 'DAOKRESH (dow-KRESH) — Kreshling war chief', full_card: 'Characters+Daokresh',
    aliases: ['daokresh'], served: false, last_served_at: null,
  },
  {
    key: 'veltin', display_name: 'Veltin', pronunciation: '',
    brief: 'VELTIN — Pilot of the station', full_card: 'Characters+Veltin',
    aliases: ['veltin'], served: true, last_served_at: '2026-01-01T00:00:00Z',
  },
  {
    key: 'kalamynth', display_name: 'Kalamynth', pronunciation: 'KAL-ah-minth',
    brief: 'KALAMYNTH (KAL-ah-minth) — mysterious oracle', full_card: 'Characters+Kalamynth',
    aliases: ['kalamynth'], served: false, last_served_at: null,
  },
] as NpcCacheEntry[];

const npcBlock = (assembler1 as any).buildNpcBlock();
assert(npcBlock.includes('DAOKRESH (dow-KRESH)'), 'Unserved NPC has full brief');
assert(npcBlock.includes('[not yet appeared]'), 'Unserved NPC marked as not appeared');
assert(npcBlock.includes('KALAMYNTH'), 'Second unserved NPC included');
assert(npcBlock.includes('Already appeared: Veltin'), 'Served NPC in compact list');
assert(!npcBlock.includes('VELTIN — Pilot'), 'Served NPC does NOT get full brief');

// ── Test 4: Anti-echo 4-gram overlap detection ─────────────────────────────

console.log('\n── Test 4: Anti-echo overlap detection ──');

// Simulate the anti-echo logic from engine.ts
function checkAntiEchoOverlap(body: string, transcript: string): number {
  const adviceWords = body.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (adviceWords.length < 4) return 0;
  const transcriptLower = transcript.toLowerCase();
  let overlapCount = 0;
  const totalNgrams = adviceWords.length - 3;
  for (let i = 0; i < totalNgrams; i++) {
    const ngram = adviceWords.slice(i, i + 4).join(' ');
    if (transcriptLower.includes(ngram)) overlapCount++;
  }
  return overlapCount / totalNgrams;
}

// High overlap: advice restates transcript
const highOverlap = checkAntiEchoOverlap(
  'The kreshling war chief Daokresh is attacking the station reactor',
  'so the kreshling war chief Daokresh is attacking the station reactor right now',
);
assert(highOverlap > 0.3, `High overlap detected (${Math.round(highOverlap * 100)}%)`);

// Low overlap: advice adds new information
const lowOverlap = checkAntiEchoOverlap(
  'Daokresh pronunciation is dow-KRESH, he commands the vanguard fleet',
  'I want to talk to the kreshling leader about the reactor',
);
assert(lowOverlap < 0.3, `Low overlap for novel advice (${Math.round(lowOverlap * 100)}%)`);

// Too short: no overlap check
const tooShort = checkAntiEchoOverlap('yes it is', 'yes it is indeed');
assert(tooShort === 0, 'Short advice skips overlap check');

// ── Tests 5-6: Context assembler pre-fetch (async, wrapped in IIFE) ─────────
// CJS mode doesn't support top-level await, so we run async tests via .then()

async function runAsyncTests(): Promise<void> {

  // ── Test 5: Context assembler pre-fetch (success path) ──────────────────

  console.log('\n── Test 5: Context assembler pre-fetch ──');

  const mockMcp = createMockMcp({
    'Episode+Station_Assault': '<h1>Station Assault</h1><p>Read aloud: The klaxons blare as emergency lights flood the concourse.</p><p>Objectives: Defend the reactor core. Rally the station crew.</p>',
    'Characters+Daokresh': '<h1>Daokresh</h1><p>Species: Kreshling. Voice: deep, guttural, impatient.</p><p>High Concept: Relentless War Chief. Trouble: Honor Before Tactics.</p>',
  });

  const pacing5 = new PacingStateManager();
  pacing5.startSession();
  pacing5.transitionTo(AssistantState.ACTIVE);
  const memory5 = new AdviceMemoryBuffer(5);
  const assembler5 = new ContextAssembler(mockMcp as any, pacing5, memory5);
  assembler5.loadTemplate(); // Uses default since no file

  const sceneBatch: TriggerBatch = {
    events: [
      {
        type: 'scene_transition_detected', priority: TriggerPriority.P2, source: 'scene-index',
        data: { scene_title: 'Station Assault', scene_card: 'Episode+Station_Assault', matched_keywords: ['station', 'kreshling'] },
        timestamp: new Date().toISOString(),
      },
      {
        type: 'npc_first_appearance', priority: TriggerPriority.P2, source: 'npc-cache',
        data: { npc_name: 'Daokresh', npc_pronunciation: 'dow-KRESH', npc_brief: 'War chief', npc_card: 'Characters+Daokresh' },
        timestamp: new Date().toISOString(),
      },
    ],
    flushedAt: new Date().toISOString(),
  };

  const context = await assembler5.assemble(sceneBatch, [
    { text: 'we need to get to the station', userId: 'player1', timestamp: new Date().toISOString() },
  ]);

  assert(context.gameState.includes('Pre-Fetched Scene Card'), 'Context includes pre-fetched scene card section');
  assert(context.gameState.includes('klaxons blare'), 'Scene card content is in context');
  assert(context.gameState.includes('Pre-Fetched NPC Card'), 'Context includes pre-fetched NPC card section');
  assert(context.gameState.includes('deep, guttural'), 'NPC card voice guidance is in context');
  assert(context.gameState.includes('pre-fetched below'), 'Trigger summary confirms pre-fetch success');
  assert(!context.gameState.includes('wiki__get_card'), 'No fallback to wiki__get_card when pre-fetch succeeds');

  // ── Test 6: Context assembler pre-fetch (failure path) ────────────────────

  console.log('\n── Test 6: Pre-fetch failure fallback ──');

  const failingMcp = createMockMcp({}); // No cards available — all fetches will fail
  const assembler6 = new ContextAssembler(failingMcp as any, pacing5, memory5);
  assembler6.loadTemplate();

  const context6 = await assembler6.assemble(sceneBatch, [
    { text: 'we need to get to the station', userId: 'player1', timestamp: new Date().toISOString() },
  ]);

  assert(!context6.gameState.includes('Pre-Fetched Scene Card'), 'No scene card section when fetch fails');
  assert(!context6.gameState.includes('Pre-Fetched NPC Card'), 'No NPC card section when fetch fails');
  assert(context6.gameState.includes('wiki__get_card'), 'Falls back to wiki__get_card instruction on failure');
  assert(context6.gameState.includes('Episode+Station_Assault'), 'Fallback includes scene card path');
  assert(context6.gameState.includes('Characters+Daokresh'), 'Fallback includes NPC card path');
}

// Run async tests, then continue with sync tests
runAsyncTests().then(() => {

// ── Test 7: Session lifecycle replay ────────────────────────────────────────

console.log('\n── Test 7: Session lifecycle replay ──');

const pacingR = new PacingStateManager();
pacingR.startSession();

const detectorR = new TriggerDetector(pacingR, fuzzyTable);
const events: Array<{ type: string; priority: number; source: string }> = [];
let activationCount = 0;

detectorR.on('activated', () => { activationCount++; });
detectorR.on('trigger', (batch) => {
  for (const evt of batch.events) {
    events.push({ type: evt.type, priority: evt.priority, source: evt.source });
  }
});
detectorR.start();

// Phase 1: PREGAME — social chat, no triggers should fire
assert(pacingR.assistantState === AssistantState.PREGAME, 'R1: Starts in PREGAME');
detectorR.onTranscriptUpdate([
  { text: 'hey everyone how was your week', userId: 'player1', timestamp: new Date().toISOString() },
  { text: 'good, just got back from vacation', userId: 'player2', timestamp: new Date().toISOString() },
]);
assert(events.length === 0, 'R2: Social chat produces no triggers');
assert(activationCount === 0, 'R3: No activation during social chat');

// Phase 2: Auto-ACTIVE — campaign proper nouns appear
detectorR.onTranscriptUpdate([
  { text: 'so last session darwin was fighting yahoo', userId: 'gm', timestamp: new Date().toISOString() },
  { text: 'yeah and dow crush showed up', userId: 'player1', timestamp: new Date().toISOString() },
]);
assert(activationCount === 1, 'R4: Auto-ACTIVE triggered by 3 proper nouns');

// Simulate orchestrator handling activation
pacingR.transitionTo(AssistantState.ACTIVE);
assert(pacingR.assistantState === AssistantState.ACTIVE, 'R5: Now in ACTIVE state');

// Phase 3: NPC cache loaded, NPC mention triggers
const mockNpcs: NpcCacheEntry[] = [
  {
    key: 'daokresh', display_name: 'Daokresh', pronunciation: 'dow-KRESH',
    brief: 'DAOKRESH (dow-KRESH) — War chief', full_card: 'Characters+Daokresh',
    aliases: ['daokresh', 'kresh'], served: false, last_served_at: null,
  },
];
detectorR.setNpcCache(mockNpcs);

detectorR.onTranscriptUpdate([
  { text: 'I want to talk to daokresh about the attack', userId: 'player1', timestamp: new Date().toISOString() },
]);
assert(mockNpcs[0].served === true, 'R6: NPC marked as served on first mention');

// Phase 4: Scene keyword detection
const mockScenes: SceneIndexEntry[] = [
  {
    id: 'station_assault', title: 'Station Assault', card: 'Episode+Station_Assault',
    keywords: ['station', 'assault', 'kreshling', 'reactor'],
    npcs: ['daokresh'], served: false, served_at: null,
  },
];
detectorR.setSceneIndex(mockScenes);

detectorR.onTranscriptUpdate([
  { text: 'we should head to the station', userId: 'player1', timestamp: new Date().toISOString() },
]);
assert(mockScenes[0].served === false, 'R7: Scene NOT served after 1 keyword');

detectorR.onTranscriptUpdate([
  { text: 'the kreshling forces are there', userId: 'player2', timestamp: new Date().toISOString() },
]);
assert(mockScenes[0].served === true, 'R8: Scene served after 2 keywords');

// Phase 5: P1 question in ACTIVE state
events.length = 0;
detectorR.onTranscriptUpdate([
  { text: 'what is the name of the reactor', userId: 'gm', timestamp: new Date().toISOString() },
]);
// P1 flushes immediately
assert(events.some(e => e.type === 'gm_question'), 'R9: P1 question detected in ACTIVE');

// Phase 6: Hesitation + simulated silence
events.length = 0;
detectorR.onTranscriptUpdate([
  { text: 'uh the captain of the guard is', userId: 'gm', timestamp: new Date().toISOString() },
]);
// Simulate timer — force hesitation check
const detAny = detectorR as any;
detAny.lastHesitationTime = Date.now() - 6000;
detAny.lastGmSpeechTime = detAny.lastHesitationTime;
detAny.checkHesitation();
assert(events.some(e => e.type === 'gm_hesitation'), 'R10: Hesitation detected after silence');

detectorR.stop();

// ── Results ─────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
process.exit(failed > 0 ? 1 : 0);

}).catch((err) => {
  console.error('Async test failure:', err);
  process.exit(1);
});
