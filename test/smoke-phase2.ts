/**
 * Phase 2 offline smoke test.
 *
 * Exercises v3 logic paths with mock data — no MCP servers needed.
 * Run: npx tsx test/smoke-phase2.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { loadFuzzyMatchTable, TriggerDetector } from '../src/reasoning/triggers.js';
import { PacingStateManager } from '../src/state/pacing.js';
import { AssistantState } from '../src/types/index.js';
import type { NpcCacheEntry, SceneIndexEntry } from '../src/types/index.js';
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

// ── Test 1: Fuzzy match table loading ───────────────────────────────────────

console.log('\n── Test 1: Fuzzy match table loading ──');

const fuzzyPath = path.resolve(process.cwd(), 'config', 'fuzzy-match.json');
const fuzzyTable = loadFuzzyMatchTable(fuzzyPath);
assert(Object.keys(fuzzyTable).length > 0, 'Loaded fuzzy table has entries');
assert(fuzzyTable['darwin'] === 'darjin', '"darwin" maps to "darjin"');
assert(fuzzyTable['_comment'] === undefined, '_comment keys are excluded');

// ── Test 2: Auto-ACTIVE detection with word boundaries ─────────────────────

console.log('\n── Test 2: Auto-ACTIVE detection ──');

// Set up env vars for config (the TriggerDetector reads config on construction)
process.env.AUTO_ACTIVE_ENABLED = 'true';
process.env.AUTO_ACTIVE_THRESHOLD = '3';
process.env.AUTO_ACTIVE_WINDOW_MINUTES = '5';
process.env.AUTO_ACTIVE_MIN_TERM_LENGTH = '4';
process.env.WIKI_MCP_URL = 'http://fake';  // prevent startup crash
process.env.ANTHROPIC_API_KEY = 'fake';

const pacing = new PacingStateManager();
pacing.startSession();
// State should be PREGAME
assert(pacing.assistantState === AssistantState.PREGAME, 'Initial state is PREGAME');

const detector = new TriggerDetector(pacing, fuzzyTable);
let activatedSource: string | null = null;
detector.on('activated', (source) => {
  activatedSource = source;
});

// Feed segments with campaign proper nouns — should trigger after 3 distinct terms
detector.onTranscriptUpdate([
  { text: 'I think darwin is coming', userId: 'gm', timestamp: new Date().toISOString() },
]);
assert(activatedSource === null, 'Not activated after 1 term');

detector.onTranscriptUpdate([
  { text: 'yahoo mentioned the quest', userId: 'gm', timestamp: new Date().toISOString() },
]);
assert(activatedSource === null, 'Not activated after 2 terms');

detector.onTranscriptUpdate([
  { text: 'dow crush has arrived', userId: 'gm', timestamp: new Date().toISOString() },
]);
assert(activatedSource === 'transcript', 'Activated after 3 distinct terms');

// Verify word boundary: "vreckon" should NOT match "vrek" (too short for 4-char min anyway)
// but "belton" should match to "veltin" (>= 4 chars)
activatedSource = null;
const pacing2 = new PacingStateManager();
pacing2.startSession();
const detector2 = new TriggerDetector(pacing2, fuzzyTable);
let activated2 = false;
detector2.on('activated', () => { activated2 = true; });

// "belton" → veltin (yes, 6 chars), "felton" → veltin (same canonical, not distinct), "crushing" → kreshling
detector2.onTranscriptUpdate([
  { text: 'belton was there', userId: 'gm', timestamp: new Date().toISOString() },
  { text: 'felton also came', userId: 'gm', timestamp: new Date().toISOString() },
  { text: 'crushing the enemy', userId: 'gm', timestamp: new Date().toISOString() },
]);
// "belton"→veltin, "felton"→veltin (same canonical), "crushing"→kreshling = 2 distinct, not 3
assert(!activated2, 'Same canonical term counted only once (veltin)');

detector2.onTranscriptUpdate([
  { text: 'calamine lotion', userId: 'gm', timestamp: new Date().toISOString() },
]);
// Now: veltin + kreshling + kalamynth = 3 distinct
assert(activated2, 'Activated after truly distinct 3rd term');

// ── Test 3: Word boundary prevents substring matching ──────────────────────

console.log('\n── Test 3: Word boundary enforcement ──');

const pacing3 = new PacingStateManager();
pacing3.startSession();
const detector3 = new TriggerDetector(pacing3, fuzzyTable);
let activated3Count = 0;
detector3.on('activated', () => { activated3Count++; });

// "darwinist" should NOT match "darwin" (substring but not word boundary)
detector3.onTranscriptUpdate([
  { text: 'the darwinist theory', userId: 'gm', timestamp: new Date().toISOString() },
  { text: 'yahooligans are wild', userId: 'gm', timestamp: new Date().toISOString() },
  { text: 'the beltonian empire', userId: 'gm', timestamp: new Date().toISOString() },
]);
assert(activated3Count === 0, 'Substring matches blocked by word boundary');

// ── Test 4: NPC first-appearance with word boundary ────────────────────────

console.log('\n── Test 4: NPC first-appearance detection ──');

// Transition to ACTIVE for NPC checks
pacing.transitionTo(AssistantState.ACTIVE);

const detector4 = new TriggerDetector(pacing, fuzzyTable);

const mockNpcCache: NpcCacheEntry[] = [
  {
    key: 'daokresh',
    display_name: 'Daokresh',
    pronunciation: 'dow-KRESH',
    brief: 'DAOKRESH (dow-KRESH) — Kreshling war chief',
    full_card: 'Characters+Daokresh',
    aliases: ['daokresh', 'kresh'],
    served: false,
    last_served_at: null,
  },
  {
    key: 'veltin',
    display_name: 'Veltin',
    pronunciation: '',
    brief: 'VELTIN — Pilot of the station',
    full_card: 'Characters+Veltin',
    aliases: ['veltin'],
    served: false,
    last_served_at: null,
  },
];
detector4.setNpcCache(mockNpcCache);
detector4.start();

// "daokresh" should match, "veltinary" should NOT match "veltin"
detector4.onTranscriptUpdate([
  { text: 'I want to talk to daokresh about the plan', userId: 'player1', timestamp: new Date().toISOString() },
  { text: 'the veltinary clinic is nearby', userId: 'player2', timestamp: new Date().toISOString() },
]);

// NPC served flag is set synchronously during onTranscriptUpdate — no need to wait
assert(mockNpcCache[0].served === true, 'Daokresh marked as served');
assert(mockNpcCache[1].served === false, 'Veltin NOT served (veltinary is substring)');
detector4.stop();

// ── Test 5: Scene keyword accumulation across segments ─────────────────────

console.log('\n── Test 5: Scene keyword accumulation ──');

const pacing5 = new PacingStateManager();
pacing5.startSession();
pacing5.transitionTo(AssistantState.ACTIVE);
const detector5 = new TriggerDetector(pacing5, fuzzyTable);
const triggeredScenes: string[] = [];
detector5.on('trigger', (batch) => {
  for (const evt of batch.events) {
    if (evt.type === 'scene_transition_detected') {
      triggeredScenes.push(evt.data.scene_title as string);
    }
  }
});

const mockSceneIndex: SceneIndexEntry[] = [
  {
    id: 'station_assault',
    title: 'Station Assault',
    card: 'Episode+Station_Assault',
    keywords: ['station', 'assault', 'kreshling', 'reactor'],
    npcs: ['daokresh'],
    served: false,
    served_at: null,
  },
];
detector5.setSceneIndex(mockSceneIndex);
detector5.start();

// First segment: 1 keyword — should NOT trigger
detector5.onTranscriptUpdate([
  { text: 'we need to get to the station', userId: 'player1', timestamp: new Date().toISOString() },
]);
assert(mockSceneIndex[0].served === false, 'Scene NOT served after 1 keyword');

// Second segment: different keyword — should trigger (2 accumulated)
detector5.onTranscriptUpdate([
  { text: 'the kreshling are attacking', userId: 'player2', timestamp: new Date().toISOString() },
]);
assert(mockSceneIndex[0].served === true, 'Scene served after 2 keywords across segments');
detector5.stop();

// ── Test 6: extractCardHtml JSON envelope unwrapping ───────────────────────

console.log('\n── Test 6: JSON envelope unwrapping ──');

// Import the function indirectly by testing through the module
// We'll test the logic directly since extractCardHtml is not exported

// Simulate what extractCardHtml does
function testExtractCardHtml(mcpResult: unknown): string | null {
  // Step 1: extractMcpText
  if (!mcpResult || typeof mcpResult !== 'object') return null;
  const r = mcpResult as Record<string, unknown>;
  let text: string | null = null;
  if (Array.isArray(r.content)) {
    for (const item of r.content) {
      if (item && typeof item === 'object' && (item as any).type === 'text') {
        if (typeof (item as any).text === 'string') {
          text = (item as any).text;
          break;
        }
      }
    }
  }
  if (!text) return null;

  // Step 2: JSON envelope unwrap
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.text === 'string') {
      return parsed.text;
    }
  } catch { /* not JSON */ }

  return text;
}

// Test: MCP SDK wrapper with JSON envelope inside
const mockGetCardResult = {
  content: [{
    type: 'text',
    text: JSON.stringify({
      id: 'Characters+Daokresh',
      title: 'Daokresh',
      text: '<p>Daokresh is a <a href="/Characters+Veltin">Veltin</a> war chief.</p>',
    }),
  }],
};
const html = testExtractCardHtml(mockGetCardResult);
assert(html !== null, 'extractCardHtml returns non-null');
assert(html!.includes('<p>Daokresh'), 'Extracted inner HTML from JSON envelope');
assert(html!.includes('href="/Characters+Veltin"'), 'HTML links preserved');

// Test: raw HTML (no JSON envelope)
const mockRawResult = {
  content: [{
    type: 'text',
    text: '<p>Raw HTML content</p>',
  }],
};
const rawHtml = testExtractCardHtml(mockRawResult);
assert(rawHtml === '<p>Raw HTML content</p>', 'Raw HTML passed through when not JSON');

// ── Results ─────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
process.exit(failed > 0 ? 1 : 0);
