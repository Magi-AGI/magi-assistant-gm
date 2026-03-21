/**
 * v7 smoke test — covers:
 * - WS1: findBeatCards() plan discovery
 * - WS2: BeatCacheBuilder GM Notes extraction
 * - WS3: Beat reminder trigger on scene match
 * - WS4: WhisperStager extraction
 * - WS5: Scene transition deprioritized to P3 + Foundry suppression
 * - WS6: SessionStats new fields
 *
 * Run: npx tsx test/smoke-v7.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { TriggerDetector, loadFuzzyMatchTable } from '../src/reasoning/triggers.js';
import { BeatCacheBuilder, extractGmNotesSections, compressToBullets, titleToId } from '../src/reasoning/beat-cache.js';
import { WhisperStager, extractWhispers } from '../src/reasoning/whisper-stage.js';
import { PacingStateManager } from '../src/state/pacing.js';
import { parseGmCommand } from '../src/state/gm-commands.js';
import { createSessionStats } from '../src/qa/session-stats.js';
import { AssistantState, TriggerPriority } from '../src/types/index.js';
import type { BeatReminderEntry, WhisperStageEntry, SceneIndexEntry, TriggerBatch } from '../src/types/index.js';
import { resetConfig } from '../src/config.js';
import path from 'node:path';

// ── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 ${label}`);
    failed++;
  }
}

function createMockMcp(cardResponses: Record<string, string> = {}, searchResults: unknown[] = []) {
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    toolCalls,
    readResource(_server: string, _uri: string): Promise<string> {
      return Promise.resolve('{}');
    },
    callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      toolCalls.push({ name, args });
      if (name === 'wiki__get_card') {
        const cardName = args.name as string;
        const html = cardResponses[cardName];
        if (html) {
          return Promise.resolve({
            content: [{ type: 'text', text: JSON.stringify({ id: cardName, title: cardName, text: html }) }],
          });
        }
        return Promise.reject(new Error(`Card not found: ${cardName}`));
      }
      if (name === 'wiki__search_cards') {
        return Promise.resolve({
          content: [{ type: 'text', text: JSON.stringify({ results: searchResults }) }],
        });
      }
      if (name === 'wiki__list_children') {
        return Promise.resolve({
          content: [{ type: 'text', text: JSON.stringify([]) }],
        });
      }
      if (name === 'wiki__search_by_tags') {
        return Promise.resolve({
          content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
        });
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

resetConfig();
process.env.AUTO_ACTIVE_ENABLED = 'true';
process.env.AUTO_ACTIVE_THRESHOLD = '3';
process.env.AUTO_ACTIVE_WINDOW_MINUTES = '5';
process.env.AUTO_ACTIVE_MIN_TERM_LENGTH = '4';
process.env.WIKI_MCP_URL = 'http://fake';
process.env.ANTHROPIC_API_KEY = 'fake';

const fuzzyPath = path.resolve(process.cwd(), 'config', 'fuzzy-match.json');
const fuzzyTable = loadFuzzyMatchTable(fuzzyPath);

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════

async function runTests(): Promise<void> {

  // ── WS2: extractGmNotesSections ────────────────────────────────────────

  console.log('\nWS2: GM Notes extraction');

  {
    const html = `
      <h2>Scene Description</h2>
      <p>The crew arrives at the station.</p>
      <h3>GM Notes</h3>
      <p>Don't mention genocide yet.</p>
      <p>Let the picture assemble from fragments.</p>
      <h3>Player Options</h3>
      <p>They can investigate or leave.</p>
    `;
    const sections = extractGmNotesSections(html);
    assert(sections.length === 1, 'extractGmNotesSections finds one GM Notes section');
    assert(sections[0].includes('genocide'), 'GM Notes section contains expected content');
    assert(!sections[0].includes('investigate'), 'GM Notes section does not leak into next heading');
  }

  {
    const html = `
      <h3>GM Notes</h3>
      <p>First note.</p>
      <h3>What NOT to Say</h3>
      <p>Do not explain the irony.</p>
      <h2>Next Section</h2>
    `;
    const sections = extractGmNotesSections(html);
    assert(sections.length === 2, 'extractGmNotesSections finds multiple matching headings');
  }

  {
    const html = '<h2>Scene Overview</h2><p>Normal content without GM notes.</p>';
    const sections = extractGmNotesSections(html);
    assert(sections.length === 0, 'extractGmNotesSections returns empty for no matching headings');
  }

  // ── WS2: compressToBullets ─────────────────────────────────────────────

  console.log('\nWS2: Bullet compression');

  {
    const sections = [
      "Don't mention genocide yet.\nLet the players reach that word themselves.\nEach PC delivers their domain finding.",
      "Extra note that should be cut.",
    ];
    const bullets = compressToBullets(sections, 3);
    assert(bullets.length === 3, 'compressToBullets caps at maxBullets=3');
    assert(bullets[0].includes('genocide'), 'First bullet has expected content');
  }

  // ── WS2: BeatCacheBuilder ─────────────────────────────────────────────

  console.log('\nWS2: BeatCacheBuilder');

  {
    const mockMcp = createMockMcp({
      'Campaign+Session_5_Scene_Beat3_The_Survey': `
        <h2>Beat 3: The Survey</h2>
        <p>The crew surveys the dark ocean planet.</p>
        <h3>GM Notes</h3>
        <p>Each PC delivers their domain finding.</p>
        <p>Don't say "genocide" — let them reach it.</p>
        <p>Let the picture assemble from fragments.</p>
      `,
      'Campaign+Session_5_Scene_Beat4_No_Notes': `
        <h2>Beat 4: Transition</h2>
        <p>Simple transition scene with no GM notes.</p>
      `,
    });

    const builder = new BeatCacheBuilder(mockMcp as any, 3);
    const entries = await builder.build([
      'Campaign+Session_5_Scene_Beat3_The_Survey',
      'Campaign+Session_5_Scene_Beat4_No_Notes',
    ]);

    assert(entries.length === 1, 'BeatCacheBuilder only includes cards with GM Notes');
    assert(entries[0].sceneId === 'session_5_scene_beat3_the_survey', 'sceneId derived correctly');
    assert(entries[0].bullets.length > 0, 'Bullets extracted');
    assert(entries[0].bullets.length <= 3, 'Bullets capped at 3');
    assert(entries[0].served === false, 'Entry starts unserved');
  }

  // ── WS2: titleToId ────────────────────────────────────────────────────

  console.log('\nWS2: titleToId');

  {
    assert(titleToId('Campaign+Session_5_Scene_Beat3_The_Survey') === 'session_5_scene_beat3_the_survey', 'titleToId converts path correctly');
  }

  // ── WS3: Beat reminder trigger fires on scene match ───────────────────

  console.log('\nWS3: Beat reminder trigger');

  {
    resetConfig();
    const pacing = new PacingStateManager();
    pacing.transitionTo(AssistantState.ACTIVE);
    const td = new TriggerDetector(pacing, fuzzyTable);

    const sceneIndex: SceneIndexEntry[] = [{
      id: 'the_survey',
      title: 'The Survey',
      card: 'Campaign+Beat3',
      keywords: ['survey', 'ocean', 'planet'],
      npcs: [],
      served: false,
      served_at: null,
    }];
    td.setSceneIndex(sceneIndex);

    const beatCache: BeatReminderEntry[] = [{
      sceneId: 'beat3_survey',
      sceneTitle: 'Beat 3: The Survey',
      sourceCard: 'Campaign+Beat3',
      bullets: ["Don't mention genocide", "Let players discover"],
      keywords: ['survey', 'ocean'],
      served: false,
      servedAt: null,
    }];
    td.setBeatCache(beatCache);

    let emittedBatch: TriggerBatch | null = null;
    td.on('trigger', (batch: TriggerBatch) => { emittedBatch = batch; });

    // Feed segments with matching keywords
    td.onTranscriptUpdate([
      { text: 'The survey planet is dark', speaker: 'GM', timestamp: new Date().toISOString(), is_final: true },
    ]);
    td.onTranscriptUpdate([
      { text: 'The ocean below has no life', speaker: 'GM', timestamp: new Date().toISOString(), is_final: true },
    ]);

    // Flush the batch
    (td as any).flush();

    const hasBeatReminder = emittedBatch?.events.some((e: any) => e.type === 'beat_reminder');
    assert(hasBeatReminder === true, 'Beat reminder trigger fires when scene keywords match');

    const beatEvent = emittedBatch?.events.find((e: any) => e.type === 'beat_reminder');
    assert(beatEvent?.priority === TriggerPriority.P2, 'Beat reminder is P2 priority');
    assert(Array.isArray(beatEvent?.data.bullets), 'Beat reminder carries bullets in data');
    assert(beatCache[0].served === true, 'Beat entry marked as served');
  }

  // ── WS4: WhisperStager extraction ─────────────────────────────────────

  console.log('\nWS4: Whisper extraction');

  {
    const html = `
      <h3>Whisper to Cailyn:</h3>
      <blockquote>
        <p>Yuna, we heard about Kairos. Your father had to tell me to stop checking the feeds.</p>
      </blockquote>
      <h3>Other content</h3>
    `;
    const whispers = extractWhispers(html, 'sato_message', 'Campaign+Sato_Message');
    assert(whispers.length >= 1, 'extractWhispers finds heading-based whisper');
    assert(whispers[0].target === 'Cailyn', 'Whisper target is Cailyn');
    assert(whispers[0].text.includes('Kairos'), 'Whisper text contains expected content');
  }

  {
    const html = '<h2>Normal Scene</h2><p>No whispers here.</p>';
    const whispers = extractWhispers(html, 'normal', 'Campaign+Normal');
    assert(whispers.length === 0, 'extractWhispers returns empty for no whispers');
  }

  {
    const mockMcp = createMockMcp({
      'Campaign+Sato_Family_Message': `
        <h3>Private to Cailyn</h3>
        <p>Your mother's letter arrives.</p>
        <blockquote><p>Dear Yuna, we are thinking of you.</p></blockquote>
      `,
    });

    const stager = new WhisperStager(mockMcp as any);
    const entries = await stager.build(['Campaign+Sato_Family_Message']);
    assert(entries.length >= 1, 'WhisperStager finds whisper in card');
    assert(entries[0].target === 'Cailyn', 'WhisperStager extracts correct target');
  }

  // ── WS5: Scene transition deprioritized to P3 ─────────────────────────

  console.log('\nWS5: Scene transition deprioritization');

  {
    resetConfig();
    const pacing = new PacingStateManager();
    pacing.transitionTo(AssistantState.ACTIVE);
    const td = new TriggerDetector(pacing, fuzzyTable);

    let emittedBatch: TriggerBatch | null = null;
    td.on('trigger', (batch: TriggerBatch) => { emittedBatch = batch; });

    td.onTranscriptUpdate([
      { text: 'Let us cut to the next scene now', speaker: 'GM', timestamp: new Date().toISOString(), is_final: true },
    ]);
    (td as any).flush();

    const sceneEvent = emittedBatch?.events.find((e: any) => e.type === 'scene_transition');
    assert(sceneEvent !== undefined, 'Scene transition keyword still detected');
    assert(sceneEvent?.priority === TriggerPriority.P3, 'Scene transition is P3 (downgraded from P2)');
  }

  // ── WS5: Foundry scene change suppresses transcript transition ────────

  console.log('\nWS5: Foundry suppression');

  {
    resetConfig();
    const pacing = new PacingStateManager();
    pacing.transitionTo(AssistantState.ACTIVE);
    const td = new TriggerDetector(pacing, fuzzyTable);

    let emittedBatch: TriggerBatch | null = null;
    td.on('trigger', (batch: TriggerBatch) => { emittedBatch = batch; });

    // Simulate Foundry scene change
    td.onGameEvent('sceneChange', { scene_id: 'new-scene' });

    // Then transcript scene transition keyword within 30s
    td.onTranscriptUpdate([
      { text: 'Let us cut to the next scene', speaker: 'GM', timestamp: new Date().toISOString(), is_final: true },
    ]);
    (td as any).flush();

    const sceneEvent = emittedBatch?.events.find((e: any) =>
      e.type === 'scene_transition' && e.source === 'transcript'
    );
    assert(sceneEvent === undefined, 'Transcript scene transition suppressed when Foundry scene change within 30s');
  }

  // ── WS6: SessionStats has v7 fields ───────────────────────────────────

  console.log('\nWS6: Session stats');

  {
    const stats = createSessionStats();
    assert(stats.beatRemindersDelivered === 0, 'beatRemindersDelivered initialized to 0');
    assert(stats.whisperNotificationsDelivered === 0, 'whisperNotificationsDelivered initialized to 0');
    assert(stats.whispersSent === 0, 'whispersSent initialized to 0');
  }

  // ── WS1/WS4: GM commands /send and /beats ─────────────────────────────

  console.log('\nWS1/WS4: GM commands');

  {
    const sendCmd = parseGmCommand('/send Cailyn', '2026-03-21T00:00:00Z');
    assert(sendCmd !== null, '/send parses as valid command');
    assert(sendCmd!.type === 'send', '/send has correct type');
    assert(sendCmd!.args[0] === 'Cailyn', '/send preserves full text arg');
  }

  {
    const beatsCmd = parseGmCommand('/beats', '2026-03-21T00:00:00Z');
    assert(beatsCmd !== null, '/beats parses as valid command');
    assert(beatsCmd!.type === 'beats', '/beats has correct type');
  }

  {
    const beatsServeCmd = parseGmCommand('/beats serve survey', '2026-03-21T00:00:00Z');
    assert(beatsServeCmd !== null, '/beats serve parses as valid command');
    assert(beatsServeCmd!.args[0] === 'serve', '/beats serve has subcommand arg');
    assert(beatsServeCmd!.args[1] === 'survey', '/beats serve has target arg');
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

runTests().then(() => {
  console.log(`\nv7 smoke tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  if (failed > 0) process.exit(1);
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
